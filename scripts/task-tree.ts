#!/usr/bin/env -S deno run --allow-run --allow-read --allow-write --allow-env
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const USAGE = `task-tree: org-root-shaped git worktree trees for parallel tasks

  new <name> [--repos a,b] [--base main] [--root <dir>]
  add <name> <repo...>
  status [<name>]
  sync <name>
  rm <name> [--force]
  env <name>
  path <name> [repo]

global: --org-root <dir>  (default: main checkout owning this script)`;

type Mode = "root" | "task" | "detached" | "nested" | "uninitialized";

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

interface Manifest {
  name: string;
  root: string;
  orgRoot: string;
  branch: string;
  base: string;
  repos: string[];
  createdAt: string;
  timings: Record<string, number>;
}

interface TreeRepo {
  path: string;
  dir: string;
  main: string;
  depth: number;
  parent: string | null;
  initialized: boolean;
}

interface RepoState {
  path: string;
  mode: Mode;
  branch: string | null;
  head: string | null;
  dirty: number;
  pointers: number;
  ahead: number | null;
  behind: number | null;
  unpushed: number | null;
  pushed: boolean | null;
}

class TaskError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
  }
}

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };
const BOOLEAN_FLAGS = new Set(["force", "help"]);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") {
      flags.help = true;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) flags[key] = a.slice(eq + 1);
      else if (BOOLEAN_FLAGS.has(key)) flags[key] = true;
      else if (i + 1 < argv.length) flags[key] = argv[++i];
      else throw new TaskError(`--${key} needs a value`);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function str(
  flags: Record<string, string | boolean>,
  key: string,
): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function log(event: string, data: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({ ts: new Date().toISOString(), event, ...data }),
  );
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    env: GIT_ENV,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout).trim(),
    stderr: new TextDecoder().decode(out.stderr).trim(),
  };
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) {
    throw new TaskError(
      `git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr}`,
    );
  }
  return r.stdout;
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

function since(t0: number): number {
  return Math.round(performance.now() - t0);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`;
}

async function resolveOrgRoot(
  flags: Record<string, string | boolean>,
): Promise<string> {
  const explicit = str(flags, "org-root");
  const start = explicit
    ? resolve(explicit)
    : dirname(dirname(new URL(import.meta.url).pathname));
  const common = await gitOk(start, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return dirname(common);
}

function stateBase(): string {
  const xdg = Deno.env.get("XDG_STATE_HOME");
  const home = Deno.env.get("HOME") ?? "/tmp";
  return join(
    xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state"),
    "swc-tasks",
  );
}

function stateDir(name: string): string {
  return join(stateBase(), name);
}

async function readManifest(name: string): Promise<Manifest | null> {
  try {
    return JSON.parse(
      await Deno.readTextFile(join(stateDir(name), "task.json")),
    );
  } catch {
    return null;
  }
}

async function writeManifest(m: Manifest): Promise<void> {
  await Deno.mkdir(stateDir(m.name), { recursive: true });
  await Deno.writeTextFile(
    join(stateDir(m.name), "task.json"),
    JSON.stringify(m, null, 2) + "\n",
  );
}

async function appendHistory(entry: Record<string, unknown>): Promise<void> {
  await Deno.mkdir(stateBase(), { recursive: true });
  await Deno.writeTextFile(
    join(stateBase(), "history.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    { append: true },
  );
}

interface Worktree {
  path: string;
  head: string;
  branch: string | null;
}

async function listWorktrees(repo: string): Promise<Worktree[]> {
  const out = await gitOk(repo, ["worktree", "list", "--porcelain"]);
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), head: "", branch: null };
      list.push(cur);
    } else if (cur && line.startsWith("HEAD ")) {
      cur.head = line.slice(5);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice(7);
    }
  }
  return list;
}

async function listTasks(
  orgRoot: string,
): Promise<{ name: string; root: string }[]> {
  return (await listWorktrees(orgRoot))
    .filter((w) => w.branch?.startsWith("refs/heads/task/"))
    .map((w) => ({
      name: w.branch!.slice("refs/heads/task/".length),
      root: w.path,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function findTask(orgRoot: string, name: string): Promise<string> {
  const t = (await listTasks(orgRoot)).find((x) => x.name === name);
  if (!t) throw new TaskError(`no task named ${name}`);
  return t.root;
}

function parseSubmodulePaths(configOut: string): string[] {
  return configOut.split("\n").filter(Boolean).map((l) =>
    l.slice(l.indexOf(" ") + 1)
  );
}

async function submodulePaths(repoDir: string): Promise<string[]> {
  const file = join(repoDir, ".gitmodules");
  if (!(await exists(file))) return [];
  const r = await git(repoDir, [
    "config",
    "-f",
    file,
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]);
  return r.code === 0 ? parseSubmodulePaths(r.stdout) : [];
}

async function isRepo(dir: string): Promise<boolean> {
  return await exists(join(dir, ".git"));
}

async function enumerateTree(
  orgRoot: string,
  root: string,
): Promise<TreeRepo[]> {
  const out: TreeRepo[] = [{
    path: ".",
    dir: root,
    main: orgRoot,
    depth: 0,
    parent: null,
    initialized: true,
  }];
  const walk = async (parent: TreeRepo) => {
    for (const sub of await submodulePaths(parent.dir)) {
      const path = parent.path === "." ? sub : `${parent.path}/${sub}`;
      const dir = join(root, path);
      const repo: TreeRepo = {
        path,
        dir,
        main: join(orgRoot, path),
        depth: parent.depth + 1,
        parent: parent.path,
        initialized: await isRepo(dir),
      };
      out.push(repo);
      if (repo.initialized) await walk(repo);
    }
  };
  await walk(out[0]);
  return out;
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await git(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]))
    .code === 0;
}

async function defaultTarget(
  repo: string,
  base: string,
): Promise<string | null> {
  for (
    const ref of [`refs/remotes/origin/${base}`, "refs/remotes/origin/HEAD"]
  ) {
    if (await refExists(repo, ref)) return ref;
  }
  return null;
}

async function gitlink(parentDir: string, sub: string): Promise<string | null> {
  const r = await git(parentDir, ["ls-tree", "HEAD", "--", sub]);
  const m = r.stdout.match(/^160000 commit ([0-9a-f]+)\t/);
  return m ? m[1] : null;
}

async function fetchAll(repos: string[]): Promise<Record<string, string>> {
  const failures: Record<string, string> = {};
  await mapLimit([...new Set(repos)], 8, async (repo) => {
    const r = await git(repo, ["fetch", "--quiet", "--prune", "origin"]);
    if (r.code !== 0) {
      failures[repo] = r.stderr;
      log("fetch_failed", { repo, stderr: r.stderr });
    }
  });
  return failures;
}

async function isDirty(dir: string): Promise<number> {
  const out = await gitOk(dir, [
    "status",
    "--porcelain=v1",
    "--ignore-submodules=all",
  ]);
  return out ? out.split("\n").length : 0;
}

async function repoState(
  repo: TreeRepo,
  name: string,
  base: string,
): Promise<RepoState> {
  if (!repo.initialized) {
    return {
      path: repo.path,
      mode: "uninitialized",
      branch: null,
      head: null,
      dirty: 0,
      pointers: 0,
      ahead: null,
      behind: null,
      unpushed: null,
      pushed: null,
    };
  }
  const sym = await git(repo.dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  const branch = sym.code === 0 ? sym.stdout : null;
  const mode: Mode = repo.path === "."
    ? "root"
    : branch === `task/${name}`
    ? "task"
    : repo.depth > 1
    ? "nested"
    : "detached";
  const head = await gitOk(repo.dir, ["rev-parse", "--short", "HEAD"]);
  const dirty = await isDirty(repo.dir);
  const full = await gitOk(repo.dir, [
    "status",
    "--porcelain=v1",
    "--ignore-submodules=none",
  ]);
  const pointers = (full ? full.split("\n").length : 0) - dirty;
  let ahead: number | null = null;
  let behind: number | null = null;
  const target = await defaultTarget(repo.dir, base);
  if (target) {
    const lr = await gitOk(repo.dir, [
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${target}`,
    ]);
    const [a, b] = lr.split(/\s+/).map(Number);
    ahead = a;
    behind = b;
  }
  const published = mode === "detached" || mode === "nested"
    ? ["--remotes=origin", "--tags"]
    : ["--remotes=origin"];
  const unpushed = Number(
    await gitOk(repo.dir, [
      "rev-list",
      "--count",
      "HEAD",
      "--not",
      ...published,
    ]),
  );
  return {
    path: repo.path,
    mode,
    branch,
    head,
    dirty,
    pointers,
    ahead,
    behind,
    unpushed,
    pushed: unpushed === 0,
  };
}

async function treeStatus(orgRoot: string, name: string, root: string) {
  const base = (await readManifest(name))?.base ?? "main";
  const repos = await enumerateTree(orgRoot, root);
  const states = await mapLimit(repos, 8, (r) => repoState(r, name, base));
  return { name, root, base, repos: states };
}

async function addWorktree(
  main: string,
  dest: string,
  opts: { branch?: string; start: string },
): Promise<void> {
  const args = ["-c", "submodule.recurse=false", "worktree", "add", "--quiet"];
  if (opts.branch) args.push("--no-track", "-b", opts.branch, dest, opts.start);
  else args.push("--detach", dest, opts.start);
  await gitOk(main, args);
}

async function removeWorktree(main: string, dir: string): Promise<void> {
  const r = await git(main, ["worktree", "remove", "--force", "--force", dir]);
  if (r.code !== 0) {
    log("worktree_remove_fallback", { main, dir, stderr: r.stderr });
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
  await git(main, ["worktree", "prune"]);
}

async function createNested(
  orgRoot: string,
  root: string,
  parentPath: string,
  created: { main: string; dir: string }[],
  records: { path: string; mode: Mode; head: string | null }[],
): Promise<void> {
  const parentDir = join(root, parentPath);
  for (const sub of await submodulePaths(parentDir)) {
    const path = `${parentPath}/${sub}`;
    const main = join(orgRoot, path);
    const sha = await gitlink(parentDir, sub);
    if (!sha || !(await isRepo(main)) || !(await refExists(main, sha))) {
      records.push({ path, mode: "uninitialized", head: null });
      continue;
    }
    const dest = join(root, path);
    await addWorktree(main, dest, { start: sha });
    created.push({ main, dir: dest });
    records.push({ path, mode: "nested", head: sha.slice(0, 12) });
    await createNested(orgRoot, root, path, created, records);
  }
}

async function cmdNew(orgRoot: string, args: Args): Promise<unknown> {
  const t0 = performance.now();
  const name = args.positional[1];
  if (!name || !NAME_RE.test(name)) {
    throw new TaskError(`invalid task name: ${name ?? "(none)"}`);
  }
  const base = str(args.flags, "base") ?? "main";
  const repos = (str(args.flags, "repos") ?? "").split(",").map((s) => s.trim())
    .filter(Boolean);
  const rootFlag = str(args.flags, "root");
  const root = resolve(
    rootFlag
      ? resolve(rootFlag)
      : join(dirname(orgRoot), `${orgRoot.split("/").pop()}-tasks`, name),
  );
  const branch = `task/${name}`;

  if (root === orgRoot || root.startsWith(orgRoot + "/")) {
    throw new TaskError(`task root must be outside the org root: ${root}`);
  }
  if (await exists(root)) {
    throw new TaskError(`task root already exists: ${root}`);
  }
  if (await refExists(orgRoot, `refs/heads/${branch}`)) {
    throw new TaskError(`org root already has branch ${branch}`);
  }
  if (await exists(stateDir(name))) {
    throw new TaskError(`task state already exists: ${stateDir(name)}`);
  }

  const tFetch = performance.now();
  const topPaths = parseSubmodulePaths(
    (await git(orgRoot, [
      "config",
      "--blob",
      `HEAD:.gitmodules`,
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ]))
      .stdout,
  );
  const initialized = [];
  for (const p of topPaths) {
    if (await isRepo(join(orgRoot, p))) initialized.push(join(orgRoot, p));
  }
  const failures = await fetchAll([orgRoot, ...initialized]);
  const fetchMs = since(tFetch);

  const orgStart = `refs/remotes/origin/${base}`;
  if (!(await refExists(orgRoot, orgStart))) {
    throw new TaskError(`org root has no ${orgStart}`);
  }
  const mainPaths = parseSubmodulePaths(
    (await git(orgRoot, [
      "config",
      "--blob",
      `${orgStart}:.gitmodules`,
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ]))
      .stdout,
  );
  for (const r of repos) {
    const main = join(orgRoot, r);
    if (!mainPaths.includes(r)) {
      throw new TaskError(`not a submodule of the org root: ${r}`);
    }
    if (!(await isRepo(main))) {
      throw new TaskError(`submodule not initialized in the org root: ${r}`);
    }
    if (failures[main]) {
      throw new TaskError(`fetch failed for ${r}: ${failures[main]}`);
    }
    if (!(await refExists(main, `refs/remotes/origin/${base}`))) {
      throw new TaskError(`${r} has no origin/${base}`);
    }
    if (await refExists(main, `refs/heads/${branch}`)) {
      throw new TaskError(`${r} already has branch ${branch}`);
    }
  }

  const created: { main: string; dir: string }[] = [];
  const branchesCreated: string[] = [];
  const records: { path: string; mode: Mode; head: string | null }[] = [];
  try {
    const tOrg = performance.now();
    await Deno.mkdir(dirname(root), { recursive: true });
    await addWorktree(orgRoot, root, { branch, start: orgStart });
    created.push({ main: orgRoot, dir: root });
    branchesCreated.push(orgRoot);
    records.push({
      path: ".",
      mode: "root",
      head: await gitOk(root, ["rev-parse", "--short", "HEAD"]),
    });
    const orgRootMs = since(tOrg);

    const tRepos = performance.now();
    const subPaths = await submodulePaths(root);
    const subRecords = await mapLimit(subPaths, 6, async (path) => {
      const main = join(orgRoot, path);
      const dest = join(root, path);
      const local: { path: string; mode: Mode; head: string | null }[] = [];
      const localCreated: { main: string; dir: string }[] = [];
      if (!(await isRepo(main))) {
        local.push({ path, mode: "uninitialized", head: null });
        return { local, localCreated };
      }
      if (repos.includes(path)) {
        await addWorktree(main, dest, {
          branch,
          start: `refs/remotes/origin/${base}`,
        });
        branchesCreated.push(main);
        localCreated.push({ main, dir: dest });
        local.push({
          path,
          mode: "task",
          head: await gitOk(dest, ["rev-parse", "--short", "HEAD"]),
        });
      } else {
        const start = (await defaultTarget(main, "main")) ??
          (await gitlink(root, path));
        if (!start) {
          local.push({ path, mode: "uninitialized", head: null });
          return { local, localCreated };
        }
        await addWorktree(main, dest, { start });
        localCreated.push({ main, dir: dest });
        local.push({
          path,
          mode: "detached",
          head: await gitOk(dest, ["rev-parse", "--short", "HEAD"]),
        });
      }
      await createNested(orgRoot, root, path, localCreated, local);
      return { local, localCreated };
    });
    for (const s of subRecords) {
      records.push(...s.local);
      created.push(...s.localCreated);
    }
    const reposMs = since(tRepos);

    const timings = { fetchMs, orgRootMs, reposMs, totalMs: since(t0) };
    const manifest: Manifest = {
      name,
      root,
      orgRoot,
      branch,
      base,
      repos,
      createdAt: new Date().toISOString(),
      timings,
    };
    await writeManifest(manifest);
    await appendHistory({
      event: "new",
      name,
      root,
      repos,
      timings,
      worktrees: created.length,
    });
    log("task_created", { name, root, worktrees: created.length, ...timings });
    return { ...manifest, stateDir: stateDir(name), worktrees: records };
  } catch (e) {
    log("task_create_rollback", { name, error: String(e) });
    for (const c of created.slice().reverse()) {
      await removeWorktree(c.main, c.dir);
    }
    for (const main of branchesCreated) {
      await git(main, ["branch", "-D", branch]);
    }
    await Deno.remove(root, { recursive: true }).catch(() => {});
    throw e;
  }
}

async function cmdAdd(orgRoot: string, args: Args): Promise<unknown> {
  const [, name, ...repoArgs] = args.positional;
  if (!name || repoArgs.length === 0) {
    throw new TaskError("usage: add <name> <repo...>");
  }
  const root = await findTask(orgRoot, name);
  const branch = `task/${name}`;
  const added: string[] = [];
  for (const repo of repoArgs) {
    const dir = join(root, repo);
    if (!(await isRepo(dir))) {
      throw new TaskError(`${repo} is not a repo in task ${name}`);
    }
    const sym = await git(dir, ["symbolic-ref", "-q", "HEAD"]);
    if (sym.code === 0) {
      throw new TaskError(`${repo} is already on a branch: ${sym.stdout}`);
    }
    await gitOk(dir, ["switch", "--quiet", "-c", branch]);
    added.push(repo);
  }
  const m = await readManifest(name);
  if (m) {
    m.repos = [...new Set([...m.repos, ...added])];
    await writeManifest(m);
  }
  await appendHistory({ event: "add", name, added });
  return { name, root, added };
}

async function cmdStatus(orgRoot: string, args: Args): Promise<unknown> {
  const name = args.positional[1];
  if (name) {
    return await treeStatus(orgRoot, name, await findTask(orgRoot, name));
  }
  const tasks = await listTasks(orgRoot);
  return await mapLimit(tasks, 4, (t) => treeStatus(orgRoot, t.name, t.root));
}

async function cmdSync(
  orgRoot: string,
  args: Args,
): Promise<{ code: number; body: unknown }> {
  const name = args.positional[1];
  if (!name) throw new TaskError("usage: sync <name>");
  const root = await findTask(orgRoot, name);
  const base = (await readManifest(name))?.base ?? "main";
  const repos = (await enumerateTree(orgRoot, root)).filter((r) =>
    r.initialized
  );
  await fetchAll(repos.map((r) => r.main));
  const results: { path: string; result: string; detail?: string }[] = [];
  const ordered = repos.slice().sort((a, b) => a.depth - b.depth);
  for (const repo of ordered) {
    const sym = await git(repo.dir, ["symbolic-ref", "-q", "--short", "HEAD"]);
    const onTask = sym.code === 0 && sym.stdout === `task/${name}`;
    if (onTask) {
      if (await isDirty(repo.dir)) {
        results.push({ path: repo.path, result: "dirty-skipped" });
        continue;
      }
      const target = `refs/remotes/origin/${base}`;
      const r = await git(repo.dir, [
        "-c",
        "submodule.recurse=false",
        "rebase",
        "--quiet",
        target,
      ]);
      if (r.code !== 0) {
        results.push({
          path: repo.path,
          result: "conflict",
          detail: r.stderr || r.stdout,
        });
        return {
          code: 1,
          body: { name, root, stoppedAt: repo.path, repos: results },
        };
      }
      results.push({ path: repo.path, result: "rebased" });
      continue;
    }
    if (sym.code === 0) {
      results.push({
        path: repo.path,
        result: "other-branch-skipped",
        detail: sym.stdout,
      });
      continue;
    }
    const target = repo.depth > 1
      ? await gitlink(
        join(root, repo.parent!),
        repo.path.slice(repo.parent!.length + 1),
      )
      : await defaultTarget(repo.dir, "main");
    if (!target) {
      results.push({ path: repo.path, result: "no-target-skipped" });
      continue;
    }
    const head = await gitOk(repo.dir, ["rev-parse", "HEAD"]);
    const targetSha = (await git(repo.dir, [
      "rev-parse",
      "--verify",
      "-q",
      `${target}^{commit}`,
    ])).stdout;
    if (!targetSha) {
      results.push({
        path: repo.path,
        result: "missing-target-skipped",
        detail: target,
      });
      continue;
    }
    if (head === targetSha) {
      results.push({ path: repo.path, result: "up-to-date" });
      continue;
    }
    if (await isDirty(repo.dir)) {
      results.push({ path: repo.path, result: "dirty-skipped" });
      continue;
    }
    const ff =
      (await git(repo.dir, ["merge-base", "--is-ancestor", head, targetSha]))
        .code === 0;
    if (repo.depth === 1 && !ff) {
      results.push({ path: repo.path, result: "diverged-skipped" });
      continue;
    }
    await gitOk(repo.dir, [
      "-c",
      "submodule.recurse=false",
      "checkout",
      "--quiet",
      "--detach",
      targetSha,
    ]);
    results.push({
      path: repo.path,
      result: ff ? "fast-forwarded" : "moved-to-gitlink",
    });
  }
  await appendHistory({ event: "sync", name });
  return { code: 0, body: { name, root, repos: results } };
}

async function cmdRm(orgRoot: string, args: Args): Promise<unknown> {
  const t0 = performance.now();
  const name = args.positional[1];
  if (!name) throw new TaskError("usage: rm <name> [--force]");
  const force = args.flags.force === true;
  const root = await findTask(orgRoot, name);
  const base = (await readManifest(name))?.base ?? "main";
  const branch = `task/${name}`;
  const repos = await enumerateTree(orgRoot, root);
  const live = repos.filter((r) => r.initialized);
  await fetchAll(live.map((r) => r.main));
  const states = await mapLimit(live, 8, (r) => repoState(r, name, base));
  const blockers = states
    .filter((s) => s.dirty > 0 || (s.unpushed ?? 0) > 0)
    .map((s) => ({
      path: s.path,
      branch: s.branch,
      dirty: s.dirty,
      unpushed: s.unpushed,
    }));
  if (blockers.length > 0 && !force) {
    throw new TaskError(
      `refusing to remove task ${name}: dirty or unpushed work in ${
        blockers.map((b) => b.path).join(", ")
      }`,
      { blockers },
    );
  }

  const removed: string[] = [];
  for (const repo of live.slice().sort((a, b) => b.depth - a.depth)) {
    await removeWorktree(repo.main, repo.dir);
    removed.push(repo.path);
  }
  await Deno.remove(root, { recursive: true }).catch(() => {});

  const deleted: string[] = [];
  const kept: string[] = [];
  for (const repo of live) {
    if (!(await refExists(repo.main, `refs/heads/${branch}`))) continue;
    const target = `refs/remotes/origin/${base}`;
    const merged = (await refExists(repo.main, target)) &&
      (await git(repo.main, [
          "merge-base",
          "--is-ancestor",
          `refs/heads/${branch}`,
          target,
        ])).code === 0;
    if (merged || force) {
      await gitOk(repo.main, ["branch", "-D", "--quiet", branch]);
      deleted.push(repo.path);
    } else {
      kept.push(repo.path);
    }
  }
  await Deno.remove(stateDir(name), { recursive: true }).catch(() => {});
  const timings = { totalMs: since(t0) };
  await appendHistory({
    event: "rm",
    name,
    root,
    force,
    timings,
    removed: removed.length,
  });
  log("task_removed", { name, root, worktrees: removed.length, ...timings });
  return {
    name,
    root,
    removed,
    branches: { deleted, kept },
    forcedPast: force ? blockers : [],
    timings,
  };
}

async function denoDir(): Promise<string> {
  const env = Deno.env.get("DENO_DIR");
  if (env) return env;
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["info", "--json"],
      env: { DENO_NO_UPDATE_CHECK: "1" },
      stdout: "piped",
      stderr: "null",
    }).output();
    const dir = JSON.parse(new TextDecoder().decode(out.stdout)).denoDir;
    if (typeof dir === "string") return dir;
  } catch {
    log("deno_info_failed");
  }
  return join(Deno.env.get("HOME") ?? "/tmp", ".cache", "deno");
}

async function cmdEnv(orgRoot: string, args: Args): Promise<string> {
  const name = args.positional[1];
  if (!name) throw new TaskError("usage: env <name>");
  const root = await findTask(orgRoot, name);
  return [
    `export TASK_NAME=${shellQuote(name)}`,
    `export TASK_ROOT=${shellQuote(root)}`,
    `export TASK_ORG_ROOT=${shellQuote(orgRoot)}`,
    `export TASK_STATE_DIR=${shellQuote(stateDir(name))}`,
    `export DENO_DIR=${shellQuote(await denoDir())}`,
    `export DENO_NO_UPDATE_CHECK=1`,
    `export TASK_DENO_FLAGS='--node-modules-dir=none'`,
    `# run deno with --node-modules-dir=none, e.g. deno check $TASK_DENO_FLAGS <entry>`,
    `mkdir -p "$TASK_STATE_DIR"`,
  ].join("\n");
}

async function cmdPath(orgRoot: string, args: Args): Promise<string> {
  const [, name, repo] = args.positional;
  if (!name) throw new TaskError("usage: path <name> [repo]");
  const root = await findTask(orgRoot, name);
  if (!repo) return root;
  const p = resolve(root, repo);
  if (relative(root, p).startsWith("..") || !(await exists(p))) {
    throw new TaskError(`no ${repo} in task ${name}`);
  }
  return p;
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args);
  const cmd = args.positional[0];
  if (!cmd || args.flags.help) {
    console.log(USAGE);
    return cmd || args.flags.help ? 0 : 2;
  }
  const orgRoot = await resolveOrgRoot(args.flags);
  switch (cmd) {
    case "new":
      console.log(JSON.stringify(await cmdNew(orgRoot, args), null, 2));
      return 0;
    case "add":
      console.log(JSON.stringify(await cmdAdd(orgRoot, args), null, 2));
      return 0;
    case "status":
      console.log(JSON.stringify(await cmdStatus(orgRoot, args), null, 2));
      return 0;
    case "sync": {
      const r = await cmdSync(orgRoot, args);
      console.log(JSON.stringify(r.body, null, 2));
      return r.code;
    }
    case "rm":
      console.log(JSON.stringify(await cmdRm(orgRoot, args), null, 2));
      return 0;
    case "env":
      console.log(await cmdEnv(orgRoot, args));
      return 0;
    case "path":
      console.log(await cmdPath(orgRoot, args));
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (e) {
    if (e instanceof TaskError) {
      console.error(
        JSON.stringify({ error: e.message, detail: e.detail ?? null }),
      );
      Deno.exit(1);
    }
    throw e;
  }
}
