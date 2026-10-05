import { walk } from "jsr:@std/fs@^1/walk";
import { relative, resolve } from "jsr:@std/path@^1";

const ORG_ROOT = resolve(Deno.args[0] ?? ".");

interface WorkspaceTests {
  workspace: string;
  testFiles: string[];
}

interface TestResult {
  workspace: string;
  passed: number;
  failed: number;
  duration: string;
  ok: boolean;
}

async function findWorkspacesWithTests(): Promise<WorkspaceTests[]> {
  const workspaces = new Map<string, string[]>();

  for await (const entry of walk(ORG_ROOT, {
    maxDepth: 5,
    includeDirs: false,
    exts: ["ts"],
    match: [/[._]test\.ts$/],
    skip: [/node_modules/, /\.git/, /\.codegraph/],
  })) {
    let dir = resolve(entry.path, "..");
    let denoJsonFound = false;

    while (dir.startsWith(ORG_ROOT)) {
      try {
        const stat = await Deno.stat(resolve(dir, "deno.json"));
        if (stat.isFile) {
          denoJsonFound = true;
          break;
        }
      } catch { /* keep walking up */ }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }

    if (!denoJsonFound) continue;

    const relWorkspace = relative(ORG_ROOT, dir) || ".";
    const relTest = relative(ORG_ROOT, entry.path);

    if (!workspaces.has(relWorkspace)) {
      workspaces.set(relWorkspace, []);
    }
    workspaces.get(relWorkspace)!.push(relTest);
  }

  return Array.from(workspaces.entries()).map(([workspace, testFiles]) => ({
    workspace,
    testFiles,
  }));
}

const EMBEDDING_PORT = 18080;

// Workspaces whose tests call out to an OpenAI-compatible /v1/embeddings
// endpoint. retrieval-skalex hardcodes localhost:18080; hono-codebase-rag-proxy
// defaults to a LAN-only address (192.168.0.20:8080) so it needs the env
// override to reach the same local fake server.
const EMBEDDING_WORKSPACE_ENV: Record<string, Record<string, string>> = {
  "codebase-rag-proxy/hono-codebase-rag-proxy": {
    EMBEDDING_URL: `http://localhost:${EMBEDDING_PORT}/v1`,
  },
};
const NEEDS_EMBEDDING_SERVER = [
  "codebase-rag-proxy/lib/retrieval-skalex",
  "codebase-rag-proxy/hono-codebase-rag-proxy",
];

async function startFakeEmbeddingsServer(): Promise<(() => void) | null> {
  const script = resolve(import.meta.dirname!, "fake-embeddings-server.ts");
  const cmd = new Deno.Command("deno", {
    args: ["run", "-A", script, String(EMBEDDING_PORT)],
    stdout: "piped",
    stderr: "null",
  });
  const child = cmd.spawn();
  const reader = child.stdout.getReader();
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    if (new TextDecoder().decode(value).includes("ready:")) { ready = true; break; }
  }
  // Verify server actually started
  if (!ready) {
    child.kill();
    console.error("Fake embeddings server failed to start — port may be in use");
    return null;
  }
  return () => { try { child.kill(); } catch { /* already dead */ } };
}

async function containerBackendRunning(): Promise<boolean> {
  // macOS: container CLI
  try {
    const cmd = new Deno.Command("container", {
      args: ["system", "status"],
      stdout: "piped",
      stderr: "null",
    });
    const { code, stdout } = await cmd.output();
    if (code === 0 && new TextDecoder().decode(stdout).includes("running")) return true;
  } catch { /* not macOS, fall through */ }
  // Linux/Windows: Docker
  try {
    const cmd = new Deno.Command("docker", {
      args: ["info", "--format", "{{.ServerVersion}}"],
      stdout: "piped",
      stderr: "null",
    });
    const { code } = await cmd.output();
    return code === 0;
  } catch { return false; }
}

async function workspaceNeedsEmbeddings(ws: WorkspaceTests): Promise<boolean> {
  // Check deno.json for skalex dependency
  try {
    const dj = JSON.parse(await Deno.readTextFile(resolve(ORG_ROOT, ws.workspace, "deno.json")));
    const imports = dj.imports ?? {};
    if (Object.values(imports).some((v) => typeof v === "string" && (v.includes("skalex") || v.includes("embedding")))) return true;
  } catch { /* no deno.json */ }
  // Check test files for embedding references
  for (const tf of ws.testFiles) {
    const content = await Deno.readTextFile(resolve(ORG_ROOT, tf));
    if (/EMBEDDING_URL|embedding|skalex/i.test(content)) return true;
  }
  return false;
}

async function runTests(ws: WorkspaceTests): Promise<TestResult> {
  const cwd = resolve(ORG_ROOT, ws.workspace);
  const cmd = new Deno.Command("deno", {
    args: [
      "test",
      "--allow-net",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-sys",
      "--allow-import",
      "--unstable-kv",
      "--unstable-worker-options",
      ...ws.testFiles.map((f) => relative(cwd, resolve(ORG_ROOT, f))),
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      ...Deno.env.toObject(),
      NO_COLOR: "1",
      ...(EMBEDDING_WORKSPACE_ENV[ws.workspace] ?? {}),
    },
  });

  const start = Date.now();
  const { code, stdout } = await cmd.output();
  const duration = `${Math.round((Date.now() - start) / 1000)}s`;

  const output = new TextDecoder().decode(stdout);
  const stripped = output.replace(/\x1b\[[0-9;]*m/g, "");
  const match = stripped.match(/(?:ok|FAILED)\s*\|\s*(\d+)\s*passed(?:\s*\([^)]*\))?\s*\|\s*(\d+)\s*failed/);
  const passed = match ? parseInt(match[1]) : 0;
  const failed = match ? parseInt(match[2]) : 0;

  return { workspace: ws.workspace, passed, failed, duration, ok: code === 0 };
}

const workspaces = await findWorkspacesWithTests();

if (workspaces.length === 0) {
  console.log("No test files found under", ORG_ROOT);
  Deno.exit(0);
}

// No `--no-check`: every workspace below is type checked as part of its
// `deno test` (see runTests). A workspace whose types do not check now fails
// the run instead of passing silently.
function printTypeCheckNotice(): void {
  console.log(
    "TYPE CHECKING ENABLED: this runner passes no --no-check, so every " +
      "workspace below is type checked before its tests run.",
  );
  console.log(
    "A green result means the tests passed AND the types checked. A type " +
      "error shows as that workspace failing.",
  );
}

console.log(
  `Running ${workspaces.length} workspace(s). Type checking is enabled for ` +
    "every one of them; this run reports test results and type errors.",
);

let stopEmbeddingServer: (() => void) | null = null;
const embeddingWorkspaces = await Promise.all(workspaces.map(async (w) =>
  NEEDS_EMBEDDING_SERVER.includes(w.workspace) || await workspaceNeedsEmbeddings(w)
));
if (embeddingWorkspaces.some(Boolean)) {
  stopEmbeddingServer = await startFakeEmbeddingsServer();
}

if (
  workspaces.some((w) => w.workspace === "hono-compute-provider") &&
  !(await containerBackendRunning())
) {
  console.warn(
    "WARNING: hono-compute-provider has container-integration tests but the " +
      "`container` backend is not running (container system start). Those " +
      "tests will fail with connection errors, not code bugs.",
  );
}

let results: TestResult[];
try {
  results = await Promise.all(workspaces.map(runTests));
} finally {
  stopEmbeddingServer?.();
}
results.sort((a, b) => a.workspace.localeCompare(b.workspace));

const colWs = Math.max(...results.map((r) => r.workspace.length), 9);
const colPass = 8;
const colFail = 8;
const colDur = 6;

const sep = `| ${"-".repeat(colWs)} | ${"-".repeat(colPass)} | ${"-".repeat(colFail)} | ${"-".repeat(colDur)} |`;

printTypeCheckNotice();
console.log("");
console.log(`| ${"workspace".padEnd(colWs)} | ${"passed".padStart(colPass)} | ${"failed".padStart(colFail)} | ${"duration".padStart(colDur)} |`);
console.log(sep);

let totalPassed = 0;
let totalFailed = 0;

for (const r of results) {
  console.log(
    `| ${r.workspace.padEnd(colWs)} | ${String(r.passed).padStart(colPass)} | ${String(r.failed).padStart(colFail)} | ${r.duration.padStart(colDur)} |`,
  );
  totalPassed += r.passed;
  totalFailed += r.failed;
}

console.log(sep);
console.log(
  `| ${"total".padEnd(colWs)} | ${String(totalPassed).padStart(colPass)} | ${String(totalFailed).padStart(colFail)} | ${"".padStart(colDur)} |`,
);
console.log(
  "NOTE: no --no-check was passed, so every workspace above was type checked " +
    "as part of its test run. A failure above may be a test failure or a type " +
    "error; the workspace must be re-run individually to tell which.",
);

// A type error (or a module resolution error) makes `deno test` exit non-zero
// WITHOUT printing a `FAILED | N passed | N failed` line, so the counters above
// stay 0 and cannot see it. The exit code is the only signal. Read it.
const failedWorkspaces = results.filter((r) => !r.ok);
if (failedWorkspaces.length > 0) {
  console.log("");
  console.log(
    `NON-ZERO EXIT: ${failedWorkspaces.map((r) => r.workspace).join(", ")}`,
  );
  console.log(
    "A non-zero exit with 0 failed tests is a type error or a module " +
      "resolution error, not a test failure. Run that workspace on its own " +
      "to see it.",
  );
}

Deno.exit(totalFailed > 0 || failedWorkspaces.length > 0 ? 1 : 0);
