// scripts/ci-discover.ts — auto-discover workspace test dirs and typecheck
// entrypoints, output JSON matrices for GitHub Actions.
//
// In CI: deno run -A scripts/ci-discover.ts
// Output format: { test: [...], typecheck: [...] }

import { walk } from "jsr:@std/fs@^1/walk";
import { resolve, relative, dirname } from "jsr:@std/path@^1";

const ORG_ROOT = resolve(".");

// ---- types ----

interface TestEntry {
  dir: string; // workspace root relative to org root
  config: string; // path to deno.json relative to org root
  flags: string; // deno test flags
  label: string; // human-readable label
  needsDocker: boolean;
  count: number;
}

interface TypecheckEntry {
  config: string; // path to deno.json relative to org root
  entrypoint: string; // path to mod.ts / main.ts relative to org root
}

// ---- workspace flag map ----
// Update when adding a new workspace or changing test flags.
// Unknown workspaces get default: -A --no-check, needsDocker: false.
//
// `--no-check` was removed from every entry below that was MEASURED to type
// check under its own flags (`deno test --no-run` with the flags listed here,
// 2026-09-22). Removing it is per-workspace: a flag left in place carries a
// reason in the comment above it. Do not clear one without re-measuring --
// `deno test` without `--no-check` exits non-zero on a type error, so a
// cleared flag on a workspace that does not type check is a red CI job, not a
// silenced one.

const FLAG_MAP: Record<string, { flags: string; needsDocker: boolean }> = {
  "hono-pds": {
    flags:
      "--allow-net --allow-env --allow-read --allow-write --allow-run --unstable-kv --unstable-worker-options",
    needsDocker: false,
  },
  "deno-worker-sandbox": {
    flags:
      "--allow-net --allow-env --allow-read --allow-write --allow-run --unstable-worker-options",
    needsDocker: false,
  },
  "atproto-market": {
    flags: "-A --unstable-kv --unstable-worker-options",
    needsDocker: true,
  },
  "policy-engine": {
    flags: "-A --unstable-worker-options",
    needsDocker: false,
  },
  "hono-compute-provider": {
    flags: "-A",
    needsDocker: true,
  },
  "did-key-ingress-proxy": {
    flags: "-A",
    needsDocker: true,
  },
  "atproto-relay": {
    flags: "-A",
    needsDocker: false,
  },
  // KEPT --no-check: this key matches NO discovered test workspace. The tests
  // under atproto-reverse-proxy/ live in the nested
  // compute-contract-reference-implementation-poc/src/typescript subtree, which
  // is a separate deno.json and therefore gets DEFAULT_FLAGS, not this entry.
  // The entry is dead as written; whether its tests type check is unmeasured
  // because they never reach it. Fixing the key is a separate change.
  "atproto-reverse-proxy": {
    flags: "-A --no-check",
    needsDocker: false,
  },
  "hono-jsr": {
    flags:
      "--allow-net --allow-read --allow-write --allow-run --allow-env",
    needsDocker: false,
  },
  "typescript-helpers": {
    flags: "--allow-env --allow-read --allow-write --allow-run",
    needsDocker: false,
  },
  "socialweb-computer-ssh": {
    flags:
      "-A --unstable-kv --unstable-worker-options --ignore=test/live_market_test.ts",
    needsDocker: false,
  },
};

// Fallback for workspaces absent from FLAG_MAP. It carries --no-check, so a
// workspace landing here is silently un-type-checked. main() names every such
// workspace on stderr -- an unnamed default is invisible in CI logs.
//
// KEPT --no-check, and this one is load-bearing: 4 workspaces land here today
// and one of them does NOT type check. Measured 2026-09-22 with this exact
// flag set minus --no-check, per workspace:
//   compute-spa                                          CLEAN
//   digitalocean-bidder                                  CLEAN
//   socialweb-computer-kcp/experiments/auth-paths/service-auth  CLEAN
//   atproto-reverse-proxy/compute-contract-reference-implementation-poc/src/typescript  DIRTY
// The dirty one fails on module resolution, not on types:
//   error: Failed resolving types. Unknown export
//   './com/atproto/repo/strongRef.defs.ts' for '@publicdomainrelay/lexicons'.
//   at lib/market/types.ts:11
// lib/lexicons/deno.json declares `"exports": "./mod.ts"` (one export, the org
// ABC rule), so its subpath -- which lib/market/types.ts imports as
// `@publicdomainrelay/lexicons/com/atproto/repo/strongRef.defs.ts` -- has no
// export to resolve. Because they are `import type`, they erase at runtime, so
// the tests pass under --no-check and fail only when types are resolved.
// Clearing this default needs that resolution fixed first, or a per-workspace
// entry for the three clean workspaces so they stop inheriting it.
const DEFAULT_FLAGS = "-A --no-check";

// ---- helpers ----

/** Walk upward from `start` to find the outermost deno.json. Returns its
 * directory (relative to org root) or null.
 *
 * "Outermost" means we keep walking up while the parent also contains a
 * deno.json.  This groups test files under the top-level workspace deno.json
 * (e.g. atproto-market/deno.json) rather than child package deno.jsons (e.g.
 * atproto-market/request-vm-ssh/deno.json).
 */
async function findDenoJsonDir(start: string): Promise<string | null> {
  let dir = resolve(start);
  let found: string | null = null;

  while (dir.startsWith(ORG_ROOT)) {
    try {
      await Deno.stat(resolve(dir, "deno.json"));
      found = relative(ORG_ROOT, dir) || ".";
    } catch { /* not here — stop, parent won't have one either */ }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

// ---- test discovery ----

async function discoverTests(): Promise<TestEntry[]> {
  const wsMap = new Map<string, string[]>(); // workspace dir → test file paths

  for await (
    const entry of walk(ORG_ROOT, {
      maxDepth: 6,
      includeDirs: false,
      exts: ["ts"],
      match: [/[._]test\.ts$/],
      skip: [/node_modules/, /\.git/, /\.codegraph/, /\.reference/],
    })
  ) {
    const wsDir = await findDenoJsonDir(entry.path);
    if (!wsDir) continue;

    const relTest = relative(ORG_ROOT, entry.path);
    if (!wsMap.has(wsDir)) wsMap.set(wsDir, []);
    wsMap.get(wsDir)!.push(relTest);
  }

  const entries: TestEntry[] = [];
  for (const [dir, testFiles] of wsMap) {
    const cfg = FLAG_MAP[dir] ?? { flags: DEFAULT_FLAGS, needsDocker: false };
    // Use the shortest unique key in FLAG_MAP that matches this dir as
    // label. For nested workspaces (atproto-reverse-proxy/...), use leaf.
    const label = dir.split("/").pop() ?? dir;
    entries.push({
      label,
      dir,
      config: `${dir}/deno.json`,
      flags: cfg.flags,
      needsDocker: cfg.needsDocker,
      count: testFiles.length,
    });
  }

  entries.sort((a, b) => a.label.localeCompare(b.label));
  return entries;
}

// ---- typecheck discovery ----
// Finds mod.ts / main.ts entrypoints at depth ≤ 1 from workspace root.
// These are CLI entrypoints — not every lib/mod.ts.

async function discoverTypechecks(
  workspaceDirs: string[],
): Promise<TypecheckEntry[]> {
  const seen = new Set<string>();
  const entries: TypecheckEntry[] = [];

  for (const wsDir of workspaceDirs) {
    const absWs = resolve(ORG_ROOT, wsDir);

    // Depth 0: main.ts in workspace root
    for (const name of ["main.ts", "mod.ts"]) {
      const p = resolve(absWs, name);
      try {
        await Deno.stat(p);
        const rel = relative(ORG_ROOT, p);
        const key = `${wsDir}:${name}`;
        if (!seen.has(key)) {
          seen.add(key);
          entries.push({ config: `${wsDir}/deno.json`, entrypoint: rel });
        }
      } catch { /* not found */ }
    }

    // Depth 1: <workspace>/<child>/mod.ts or main.ts — CLI entrypoints
    try {
      for await (const dirEntry of Deno.readDir(absWs)) {
        if (!dirEntry.isDirectory) continue;
        if (dirEntry.name.startsWith(".")) continue;
        if (["test", "node_modules", "lib", "scripts"].includes(dirEntry.name)) continue;
        for (const name of ["mod.ts", "main.ts"]) {
          const childEntry = resolve(absWs, dirEntry.name, name);
          try {
            await Deno.stat(childEntry);
            const rel = relative(ORG_ROOT, childEntry);
            const key = `${wsDir}:${dirEntry.name}/${name}`;
            if (!seen.has(key)) {
              seen.add(key);
              entries.push({ config: `${wsDir}/deno.json`, entrypoint: rel });
            }
          } catch { /* not found */ }
        }
      }
    } catch { /* cannot read dir */ }
  }

  entries.sort((a, b) => a.entrypoint.localeCompare(b.entrypoint));
  return entries;
}

// ---- main ----

const testEntries = await discoverTests();
const workspaceDirs = [...new Set(testEntries.map((t) => t.dir))];
const typecheckEntries = await discoverTypechecks(workspaceDirs);

const output = {
  test: testEntries,
  typecheck: typecheckEntries,
};

// stderr, never stdout: stdout is the JSON matrix CI parses.
const defaulted = testEntries.filter((t) => FLAG_MAP[t.dir] === undefined);
console.error(
  `ci-discover: ${testEntries.length} test workspaces; ` +
    `${defaulted.length} not in FLAG_MAP, so they get the default ` +
    `"${DEFAULT_FLAGS}" and are NOT type checked.`,
);
for (const t of defaulted) {
  console.error(`  defaulted: ${t.dir}  ->  ${t.flags}`);
}

console.log(JSON.stringify(output));
