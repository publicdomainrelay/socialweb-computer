---
name: testAll
description: >-
  Run all tests across entire poly-repo org root in parallel.
  Trigger: /testAll, "run all tests", "test everything",
  "test all repos", "run tests everywhere".
---

# testAll

Run `deno run -A scripts/test-all.ts` from org root. Script finds all
workspaces with `*_test.ts` / `*.test.ts` files, runs `deno test` in each
in parallel, reports results as table.

## Workflow

1. Run the script:

```
deno run -A scripts/test-all.ts
```

2. Script outputs a table, preceded and followed by an explicit notice that
   type checking is ENABLED (see below):

```
Running 3 workspace(s). Type checking is enabled for every one of them; this run reports test results and type errors.
TYPE CHECKING ENABLED: this runner passes no --no-check, so every workspace below is type checked before its tests run.
A green result means the tests passed AND the types checked. A type error shows as that workspace failing.

| workspace            |  passed |  failed | duration |
| -------------------- | ------- | ------- | -------- |
| hono-pds             |     100 |       0 |      11s |
| deno-worker-sandbox  |      24 |       0 |       5s |
| hono-jsr             |       5 |       0 |       2s |
| -------------------- | ------- | ------- | -------- |
| total                |     129 |       0 |          |

NOTE: no --no-check was passed, so every workspace above was type checked as part of its test run.
```

3. If a workspace did not type check, the `failed` column cannot show it (a
   type error produces no `FAILED | N passed | N failed` line, so it counts as
   0). The script reads the exit code instead and prints, after the table:

```
NON-ZERO EXIT: ws-example
A non-zero exit with 0 failed tests is a type error or a module resolution error, not a test failure.
Run that workspace on its own to see it.
```

Its own exit code is non-zero when that block is non-empty.

4. If any workspace has failures: show the workspace name + count. Offer
   to re-run that workspace individually for details. For a workspace named in
   the `NON-ZERO EXIT` block, the count is 0 -- re-run that one on its own and
   show its type error, do not report it as a test failure.

5. If a workspace has zero test files: skip it (not listed in table).

## How it works

- Walks org root (maxdepth 5) finding `*_test.ts` / `*.test.ts` files
- Groups files by nearest parent containing `deno.json` (workspace root)
- Runs `deno test` with full permissions in each workspace -- **type checking
  is ON, there is no `--no-check`**
- All workspaces run in parallel via `Promise.all`
- Parses `deno test` stdout for a `ok | N passed | N failed` or
  `FAILED | N passed | N failed` summary line, and separately reads the exit
  code (a type error prints no summary line at all)

## This runner DOES type check — read the notice

**No `--no-check` is passed to any workspace.** Every workspace is type checked
as part of its `deno test`, and the script says so above and below the table.
A green run now means the tests passed *and* the types checked. That is a
reversal: this runner used to pass `--no-check` everywhere.

The reversal needed two things, because removing the flag alone is not enough:

1. **The one blocking type error.** Measured 2026-09-22 over exactly the file
   list this script passes (`deno test --no-run`, check without executing), 15
   workspaces: only `did-key-ingress-proxy` failed, with 1 error —
   `test/tunnel_test.ts:113` passing `ReadableStream<Uint8Array<ArrayBufferLike>>`
   into `TunnelClientOptions.readable`, declared `ReadableStream<Uint8Array<ArrayBuffer>>`
   at `lib/did-key-ingress-proxy-subscriber-xrpc/mod.ts:461`. Fixed by widening
   the declaration to `ArrayBufferLike` (the supertype: every existing caller
   keeps working). All 15 workspaces now type check clean.

2. **The exit code, not the counter.** A type error makes `deno test` exit
   non-zero *without* printing a `FAILED | N passed | N failed` line, so it
   counts as `0 passed | 0 failed` and the `failed` column cannot see it. The
   script therefore reads the exit code separately and prints a
   `NON-ZERO EXIT: <workspace>` block naming each workspace that exited
   non-zero, and exits non-zero itself when any did. Without this, flipping the
   flag would have moved the silent pass rather than removed it — verified on a
   throwaway fixture org root: the pre-fix script reported
   `0 passed | 0 failed` and **exited 0** for a workspace with a deliberate
   type error.

`did-key-ingress-proxy` also has a PRE-EXISTING RUNTIME FAILURE, unrelated to
typing and not fixed here: `test/tunnel_test.ts` fails inside `createSubscriber`
with `nonce request failed: 401 {"error":"AuthenticationRequired","message":
"Error: jwt signature does not match jwt issuer"}`. The workspace type checks;
that one test still fails. Do not read it as a type error — with the fix the
type error is gone and this 401 is what is left.

## The separate CI `typecheck` matrix (a different, still-red thing)

`scripts/ci-discover.ts` also emits a `typecheck` matrix, and CI runs it as its
own job. That is `deno check --config <deno.json> <entrypoint>` over `mod.ts` /
`main.ts` entrypoints — a different and much narrower set than the test files,
and it is red independently of this runner. Measured 2026-09-22: **7 of 30
entries fail, all inside
`atproto-reverse-proxy/compute-contract-reference-implementation-poc/`** —
4 on module resolution and 3 on real type errors (`TS2304 Cannot find name
'SEMVER_RE'` x2, `TS2339 Property 'isatty' does not exist on type 'typeof Deno'`).
The module-resolution ones are all the same cause: `lib/lexicons/deno.json`
declares `"exports": "./mod.ts"` (one export, the org ABC rule), so
`lib/market/types.ts`'s `import type ... from
"@publicdomainrelay/lexicons/com/atproto/repo/strongRef.defs.ts"` has no
subpath export to resolve. They are `import type`, so they erase at runtime and
the tests pass — only type resolution fails. Nothing here fixes that; it is a
publish/resolution problem, not a typing one, and it belongs to its own change.

## Environment setup done automatically

- **codebase-rag-proxy embeddings**: `retrieval-skalex` and
  `hono-codebase-rag-proxy` tests need a real OpenAI-compatible
  `/v1/embeddings` endpoint. The script spawns
  `scripts/fake-embeddings-server.ts` on `localhost:18080` (deterministic
  hash-based vectors, no real model) before running those two workspaces,
  and injects `EMBEDDING_URL=http://localhost:18080/v1` for
  `hono-codebase-rag-proxy` (its default points at a LAN-only address).
  Server is killed after the run.
- **hono-compute-provider container tests**: needs the macOS `container`
  backend running (`container system start`). The script checks
  `container system status` and prints a warning (not a failure) if it's
  down — those tests will show connection-timeout failures, not code bugs,
  when the backend is unavailable. It does NOT auto-start the backend or
  clean up leftover test containers — if `container list` shows a pile of
  leaked `pdr-*` VMs from previous runs, stop+rm them by hand
  (`container stop <id> && container rm <id>`) before rerunning, since a
  large pile can cause IP/resource exhaustion that looks like test flakiness.

## Script flags

- `<org-root>` — override org root as first positional arg (default: cwd)
