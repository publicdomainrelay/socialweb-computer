import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "jsr:@std/assert@^1";
import { dirname, join } from "node:path";

const SCRIPT = join(dirname(new URL(import.meta.url).pathname), "task-tree.ts");

interface Fixture {
  tmp: string;
  remotes: string;
  org: string;
  env: Record<string, string>;
  stateHome: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<RunResult> {
  const out = await new Deno.Command(cmd, {
    args,
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function git(
  fx: Fixture,
  cwd: string,
  ...args: string[]
): Promise<string> {
  const r = await run("git", args, cwd, fx.env);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

async function tt(fx: Fixture, ...args: string[]): Promise<RunResult> {
  return await run(
    Deno.execPath(),
    ["run", "-A", SCRIPT, ...args, "--org-root", fx.org],
    fx.tmp,
    fx.env,
  );
}

async function ttOk(fx: Fixture, ...args: string[]): Promise<string> {
  const r = await tt(fx, ...args);
  if (r.code !== 0) {
    throw new Error(`task-tree ${args.join(" ")} exit ${r.code}: ${r.stderr}`);
  }
  return r.stdout;
}

async function commitFile(
  fx: Fixture,
  repo: string,
  file: string,
  content: string,
  message: string,
): Promise<void> {
  await Deno.mkdir(dirname(join(repo, file)), { recursive: true });
  await Deno.writeTextFile(join(repo, file), content);
  await git(fx, repo, "add", file);
  await git(fx, repo, "commit", "-q", "-m", message);
}

async function seedRepo(
  fx: Fixture,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const bare = join(fx.remotes, `${name}.git`);
  await git(fx, fx.remotes, "init", "-q", "--bare", "-b", "main", bare);
  const work = join(fx.tmp, "seed", name);
  await git(fx, fx.tmp, "clone", "-q", bare, work);
  for (const [file, content] of Object.entries(files)) {
    await Deno.mkdir(dirname(join(work, file)), { recursive: true });
    await Deno.writeTextFile(join(work, file), content);
  }
  await git(fx, work, "add", ".");
  await git(fx, work, "commit", "-q", "-m", `seed ${name}`);
  await git(fx, work, "push", "-q", "origin", "main");
  return bare;
}

async function advanceRemote(
  fx: Fixture,
  name: string,
  file: string,
  content: string,
): Promise<string> {
  const work = join(fx.tmp, "advance", `${name}-${crypto.randomUUID()}`);
  await git(fx, fx.tmp, "clone", "-q", join(fx.remotes, `${name}.git`), work);
  await commitFile(fx, work, file, content, `advance ${name}`);
  await git(fx, work, "push", "-q", "origin", "main");
  return await git(fx, work, "rev-parse", "HEAD");
}

const LIB_B_MOD =
  "export function greet(who: string): string {\n  return `hi ${who}`;\n}\n";
const APP_A_MOD =
  'import { greet } from "@fixture/lib-b";\n\nexport const message: string = greet("a");\n';
const APP_A_DENO = JSON.stringify(
  { imports: { "@fixture/lib-b": "../lib-b/mod.ts" } },
  null,
  2,
);

async function makeFixture(): Promise<Fixture> {
  const tmp = await Deno.makeTempDir({ prefix: "task-tree-test-" });
  const remotes = join(tmp, "remotes");
  await Deno.mkdir(remotes, { recursive: true });
  const gitConfig = join(tmp, "gitconfig");
  await Deno.writeTextFile(
    gitConfig,
    [
      "[user]",
      "\tname = Fixture",
      "\temail = fixture@example.invalid",
      "[init]",
      "\tdefaultBranch = main",
      '[protocol "file"]',
      "\tallow = always",
      "[commit]",
      "\tgpgsign = false",
      "[advice]",
      "\tdetachedHead = false",
      "",
    ].join("\n"),
  );
  const stateHome = join(tmp, "state");
  const env: Record<string, string> = {
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    XDG_STATE_HOME: stateHome,
    DENO_NO_UPDATE_CHECK: "1",
  };
  const fx: Fixture = {
    tmp,
    remotes,
    org: join(tmp, "org-root"),
    env,
    stateHome,
  };

  const nestBare = await seedRepo(fx, "nest", { "nest.txt": "nest\n" });
  const nestSeed = join(tmp, "seed", "nest");
  await git(fx, nestSeed, "checkout", "-q", "--detach");
  await commitFile(
    fx,
    nestSeed,
    "release.txt",
    "v1\n",
    "release only reachable by tag",
  );
  await git(fx, nestSeed, "tag", "v1");
  await git(fx, nestSeed, "push", "-q", "origin", "v1");
  await seedRepo(fx, "lib-b", { "mod.ts": LIB_B_MOD, "deno.json": "{}\n" });
  const libSeed = join(tmp, "seed", "lib-b");
  await git(fx, libSeed, "submodule", "add", "-q", nestBare, "vendor/nest");
  await git(fx, join(libSeed, "vendor/nest"), "checkout", "-q", "v1");
  await git(fx, libSeed, "add", "vendor/nest");
  await git(fx, libSeed, "commit", "-q", "-m", "nested submodule");
  await git(fx, libSeed, "push", "-q", "origin", "main");
  const appBare = await seedRepo(fx, "app-a", {
    "mod.ts": APP_A_MOD,
    "deno.json": APP_A_DENO,
  });

  const orgBare = join(remotes, "org.git");
  await git(fx, remotes, "init", "-q", "--bare", "-b", "main", orgBare);
  const orgSeed = join(tmp, "seed", "org");
  await git(fx, tmp, "clone", "-q", orgBare, orgSeed);
  await Deno.writeTextFile(join(orgSeed, "README.md"), "org\n");
  await git(fx, orgSeed, "add", "README.md");
  await git(fx, orgSeed, "submodule", "add", "-q", appBare, "app-a");
  await git(
    fx,
    orgSeed,
    "submodule",
    "add",
    "-q",
    join(remotes, "lib-b.git"),
    "lib-b",
  );
  await git(fx, orgSeed, "commit", "-q", "-m", "org seed");
  await git(fx, orgSeed, "push", "-q", "origin", "main");

  await git(fx, tmp, "clone", "-q", orgBare, fx.org);
  await git(fx, fx.org, "submodule", "update", "-q", "--init", "app-a");
  await git(fx, fx.org, "submodule", "init", "-q", "lib-b");
  await git(
    fx,
    fx.org,
    "clone",
    "-q",
    "--recurse-submodules",
    join(remotes, "lib-b.git"),
    "lib-b",
  );
  return fx;
}

interface RepoSnapshot {
  head: string;
  symbolic: string;
  status: string;
  refs: string;
  worktreeFiles: string;
}

async function snapshotRepo(fx: Fixture, dir: string): Promise<RepoSnapshot> {
  const symbolic = await run(
    "git",
    ["symbolic-ref", "-q", "HEAD"],
    dir,
    fx.env,
  );
  const refs = (await git(
    fx,
    dir,
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    "refs/heads",
  ))
    .split("\n")
    .filter((l) => !l.startsWith("refs/heads/task/"))
    .join("\n");
  const files: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.name === ".git") continue;
    const p = join(dir, e.name);
    files.push(
      e.isFile ? `${e.name}:${await Deno.readTextFile(p)}` : `${e.name}/`,
    );
  }
  return {
    head: await git(fx, dir, "rev-parse", "HEAD"),
    symbolic: symbolic.stdout.trim(),
    status: await git(
      fx,
      dir,
      "status",
      "--porcelain=v1",
      "--ignore-submodules=none",
    ),
    refs,
    worktreeFiles: files.sort().join("\n"),
  };
}

async function snapshotMain(
  fx: Fixture,
): Promise<Record<string, RepoSnapshot>> {
  const out: Record<string, RepoSnapshot> = {};
  for (const p of [".", "app-a", "lib-b", "lib-b/vendor/nest"]) {
    out[p] = await snapshotRepo(fx, join(fx.org, p));
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function cleanup(fx: Fixture): Promise<void> {
  await Deno.remove(fx.tmp, { recursive: true }).catch(() => {});
}

Deno.test("task-tree script type checks", async () => {
  const r = await run(
    Deno.execPath(),
    ["check", SCRIPT],
    dirname(SCRIPT),
    Deno.env.toObject(),
  );
  assertEquals(r.code, 0, r.stderr);
});

Deno.test("new builds a real-directory org-shaped tree that resolves sibling imports", async () => {
  const fx = await makeFixture();
  try {
    const before = await snapshotMain(fx);
    const libTip = await advanceRemote(fx, "lib-b", "extra.txt", "x\n");

    const created = JSON.parse(await ttOk(fx, "new", "t1", "--repos", "app-a"));
    const root = join(`${fx.org}-tasks`, "t1");
    assertEquals(created.root, root);
    assertEquals(created.branch, "task/t1");
    assert(typeof created.timings.totalMs === "number");

    for (const p of ["app-a", "lib-b", "lib-b/vendor/nest"]) {
      const st = await Deno.lstat(join(root, p));
      assert(st.isDirectory && !st.isSymlink, `${p} must be a real directory`);
    }
    assertEquals(
      await git(fx, root, "rev-parse", "--abbrev-ref", "HEAD"),
      "task/t1",
    );
    assertEquals(
      await git(fx, join(root, "app-a"), "rev-parse", "--abbrev-ref", "HEAD"),
      "task/t1",
    );
    assertEquals(
      await git(fx, join(root, "lib-b"), "rev-parse", "--abbrev-ref", "HEAD"),
      "HEAD",
    );
    assertEquals(
      await git(fx, join(root, "lib-b"), "rev-parse", "HEAD"),
      libTip,
    );
    assertEquals(
      await Deno.readTextFile(join(root, "lib-b/vendor/nest/nest.txt")),
      "nest\n",
    );

    const check = await run(
      Deno.execPath(),
      ["check", "--node-modules-dir=none", "mod.ts"],
      join(root, "app-a"),
      fx.env,
    );
    assertEquals(check.code, 0, check.stderr);

    assertEquals((await ttOk(fx, "path", "t1")).trim(), root);
    assertEquals(
      (await ttOk(fx, "path", "t1", "app-a")).trim(),
      join(root, "app-a"),
    );

    const env = await ttOk(fx, "env", "t1");
    assertMatch(
      env,
      new RegExp(`export TASK_STATE_DIR='${fx.stateHome}/swc-tasks/t1'`),
    );
    assertMatch(env, /export DENO_NO_UPDATE_CHECK=1/);
    assertMatch(env, /export DENO_DIR='[^']+'/);
    assertMatch(env, /--node-modules-dir=none/);

    const again = await tt(fx, "new", "t1");
    assertNotEquals(again.code, 0);
    const inside = await tt(
      fx,
      "new",
      "t9",
      "--root",
      join(fx.org, "nested-task"),
    );
    assertNotEquals(inside.code, 0);
    assert(!(await exists(join(fx.org, "nested-task"))));

    assertEquals(await snapshotMain(fx), before);
  } finally {
    await cleanup(fx);
  }
});

Deno.test("changes in two repos are seen together and pointers show in the task root", async () => {
  const fx = await makeFixture();
  try {
    const before = await snapshotMain(fx);
    await ttOk(fx, "new", "t2", "--repos", "app-a");
    const root = join(`${fx.org}-tasks`, "t2");

    const added = JSON.parse(await ttOk(fx, "add", "t2", "lib-b"));
    assertEquals(added.added, ["lib-b"]);
    assertEquals(
      await git(fx, join(root, "lib-b"), "rev-parse", "--abbrev-ref", "HEAD"),
      "task/t2",
    );

    await commitFile(
      fx,
      join(root, "lib-b"),
      "mod.ts",
      LIB_B_MOD +
        "\nexport function shout(who: string): string {\n  return who.toUpperCase();\n}\n",
      "lib-b: shout",
    );
    await commitFile(
      fx,
      join(root, "app-a"),
      "mod.ts",
      'import { greet, shout } from "@fixture/lib-b";\n\nexport const message: string = shout(greet("a"));\n',
      "app-a: use shout",
    );
    const check = await run(
      Deno.execPath(),
      ["check", "--node-modules-dir=none", "mod.ts"],
      join(root, "app-a"),
      fx.env,
    );
    assertEquals(check.code, 0, check.stderr);

    const porcelain = await git(fx, root, "status", "--porcelain=v1");
    assertMatch(porcelain, /^ ?M app-a$/m);
    assertMatch(porcelain, /^ ?M lib-b$/m);
    await git(fx, root, "add", "app-a", "lib-b");
    await git(fx, root, "commit", "-q", "-m", "pointer combo");
    assertEquals(
      await git(fx, root, "status", "--porcelain=v1", "--", "app-a", "lib-b"),
      "",
    );

    const status = JSON.parse(await ttOk(fx, "status", "t2"));
    const byPath = Object.fromEntries(
      status.repos.map((r: { path: string }) => [r.path, r]),
    );
    assertEquals(byPath["app-a"].branch, "task/t2");
    assertEquals(byPath["app-a"].ahead, 1);
    assertEquals(byPath["app-a"].pushed, false);
    assertEquals(byPath["lib-b"].ahead, 1);
    assertEquals(byPath["."].ahead, 1);

    const all = JSON.parse(await ttOk(fx, "status"));
    assertEquals(all.map((t: { name: string }) => t.name), ["t2"]);

    const mainApp = await Deno.readTextFile(join(fx.org, "app-a", "mod.ts"));
    assertEquals(mainApp, APP_A_MOD);
    assertEquals(await snapshotMain(fx), before);
  } finally {
    await cleanup(fx);
  }
});

Deno.test("sync rebases task branches and fast-forwards detached siblings", async () => {
  const fx = await makeFixture();
  try {
    await ttOk(fx, "new", "t3", "--repos", "app-a");
    const root = join(`${fx.org}-tasks`, "t3");
    await commitFile(
      fx,
      join(root, "app-a"),
      "task.txt",
      "task\n",
      "task work",
    );
    const appTip = await advanceRemote(fx, "app-a", "upstream.txt", "up\n");
    const libTip = await advanceRemote(fx, "lib-b", "upstream.txt", "up\n");

    const synced = JSON.parse(await ttOk(fx, "sync", "t3"));
    const byPath = Object.fromEntries(
      synced.repos.map((r: { path: string }) => [r.path, r]),
    );
    assertEquals(byPath["app-a"].result, "rebased");
    assertEquals(byPath["lib-b"].result, "fast-forwarded");
    assertEquals(
      await git(fx, join(root, "lib-b"), "rev-parse", "HEAD"),
      libTip,
    );
    assertEquals(
      await git(fx, join(root, "app-a"), "rev-parse", "HEAD~1"),
      appTip,
    );

    await commitFile(
      fx,
      join(root, "app-a"),
      "upstream.txt",
      "mine\n",
      "conflicting",
    );
    await advanceRemote(fx, "app-a", "upstream.txt", "theirs\n");
    const conflict = await tt(fx, "sync", "t3");
    assertNotEquals(conflict.code, 0);
    const report = JSON.parse(conflict.stdout);
    assertEquals(report.stoppedAt, "app-a");
  } finally {
    await cleanup(fx);
  }
});

Deno.test("rm refuses dirty or unpushed work, keeps main checkouts untouched", async () => {
  const fx = await makeFixture();
  try {
    const before = await snapshotMain(fx);
    await ttOk(fx, "new", "t4", "--repos", "app-a");
    const root = join(`${fx.org}-tasks`, "t4");
    const app = join(root, "app-a");

    await Deno.writeTextFile(join(app, "scratch.txt"), "dirty\n");
    const dirty = await tt(fx, "rm", "t4");
    assertNotEquals(dirty.code, 0);
    assertMatch(dirty.stderr, /app-a/);
    assert(await exists(root));

    await git(fx, app, "add", "scratch.txt");
    await git(fx, app, "commit", "-q", "-m", "work");
    const unpushed = await tt(fx, "rm", "t4");
    assertNotEquals(unpushed.code, 0);
    assertMatch(unpushed.stderr, /unpushed/);
    assert(await exists(root));

    await git(fx, app, "push", "-q", "origin", "task/t4");
    const removed = JSON.parse(await ttOk(fx, "rm", "t4"));
    assert(!(await exists(root)));
    assert(removed.branches.kept.includes("app-a"));
    assert(removed.branches.deleted.includes("."));
    assertEquals(
      await git(fx, join(fx.org, "app-a"), "branch", "--list", "task/t4"),
      "task/t4",
    );
    assertEquals(await git(fx, fx.org, "branch", "--list", "task/t4"), "");
    for (const p of [".", "app-a", "lib-b", "lib-b/vendor/nest"]) {
      const list = await git(
        fx,
        join(fx.org, p),
        "worktree",
        "list",
        "--porcelain",
      );
      assert(!list.includes(root), `${p} still lists ${root}`);
    }
    assert(!(await exists(join(fx.stateHome, "swc-tasks", "t4"))));

    await ttOk(fx, "new", "t5", "--repos", "app-a,lib-b");
    const root5 = join(`${fx.org}-tasks`, "t5");
    await commitFile(fx, join(root5, "lib-b"), "x.txt", "x\n", "unpushed");
    await Deno.writeTextFile(join(root5, "app-a", "y.txt"), "y\n");
    const forced = JSON.parse(await ttOk(fx, "rm", "t5", "--force"));
    assert(!(await exists(root5)));
    assert(forced.branches.deleted.includes("lib-b"));
    assertEquals(
      await git(fx, join(fx.org, "lib-b"), "branch", "--list", "task/t5"),
      "",
    );

    assertEquals(await snapshotMain(fx), before);
  } finally {
    await cleanup(fx);
  }
});
