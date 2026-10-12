# publicdomainrelay typescript

**ALL TypeScript work** use this Deno + Hono + JSR "ABC-layering" style. Always
active. Pattern applies per repo. Poly repo: all org repos live under dir holding
this file = **org root**.

Always run `./scripts/find-all-package.ts | yq -P` on session start to see where
everything lives.

## Open Architecture — docs-as-code blueprint

`open-architecture/` is a **docs-as-code** translation of
`open_architecture_today.md` into TypeScript stub functions organized in ABC
layers. Each function = one paragraph of the document. Function body = calls to
sub-concepts that paragraph depends on. **The call graph IS the architecture.**
Walk the references and you walk her whole reasoning. Explore with:

```
codegraph explore "whatAliceIs theInfiniteLoop puttingItTogether"
```

**STATUS_REPORT.md** (`open-architecture/STATUS_REPORT.md`) maps every
docs-as-code stub to its production implementation across the polyrepo.
Read it to understand what's built vs what's still stub.

**Regenerate the status report**: ask Claude to "regenerate the status report"
or invoke the `status-report` agent. Fans out 5 cavecrew-investigator subagents
across the polyrepo, maps findings to stubs, writes `STATUS_REPORT.md`.

## RFP flow is the spine — NEVER bypass it

This entire project exists to provision compute through the **RFP / market
flow**. A requester posts a `compute.vm` record + a signed `market.rfp`; bidders
bid; the winner provisions a guest **via cloud-init `user_data`**
(`buildUserData` composer + module registry in `cloud-init-common`); the requester reaches the guest
**only through the relay** (ssh `ProxyCommand` over the websocket tunnel). The
relay is the registry. Nothing talks to a guest except through this path.

**NEVER — non-negotiable, breaks the whole point of the project:**

- Provision a container/VM by hand in code OR tests (`container run`,
  `docker run`, `container exec ... apt-get install`, mounting a binary,
  `ssh-keygen` + manual `authorized_keys`). Guests are born from cloud-init
  `user_data` produced by the RFP flow, never hand-assembled.
- Cross-compile/mount a guest agent to skip cloud-init. The agent (sshd,
  websocat, fedproxy-client, tunnel subscriber, …) is installed BY the
  cloud-init `user_data` the bidder applies.
- Write a "real ssh / real guest" e2e that stands up its own container instead
  of driving `runComputeContract(...)`. If a test needs a live guest, it drives
  the requester (`runComputeContract`) against a real local bidder running a
  container-mode compute provider (see
  `atproto-market/test/bidder_container_integration_test.ts` for the canonical
  harness: local dispatcher + fake PLC + bidder + requester, fetch patched so
  `https://*.localhost` → local dispatcher). Provisioning ALWAYS goes
  requester → RFP → bid → accept → cloud-init.
- Add a second SSH/tunnel transport that the RFP cloud-init does not deploy. New
  guest-side transport = add a `UserDataModule` to `cloud-init-common`'s registry
  (or a sibling user_data builder) that installs it, so the RFP flow remains the
  only way a guest comes up.

**Pre-flight before any provisioning / guest / ssh / tunnel code or test:** Does
this go through `runComputeContract` + RFP records + cloud-init? If it calls
`container run`/`docker run`/`exec` directly, STOP — it is wrong.

## Bash CWD

Bash tool persists CWD across calls. `cd` in one call = CWD for next call.
Always start every Bash command with `cd <absolute-path> &&` when targeting
a specific workspace. Never assume CWD.

```
cd /home/johnandersen777/src/publicdomainrelay/hono-pds && deno test ...
cd /home/johnandersen777/src/publicdomainrelay/hono-compute-provider && deno check ...
```

## kcp is part of the application (paradigm)

We use kcp as a core part of applications, not as infrastructure. An application
instance (bidder, requester, gateway, market test bed, dev instance) = its own kcp
+ a manifest set + a profile. State = kcp objects; components = DenoPods /
HostProcesses reconciled from them (not many servers inside one deno process);
modes = profiles; composition = apply manifest sets / nest workspaces.
Applications talk only over the atproto market protocol, never by sharing a kcp.
Never frame designs as host/cluster topology. Only the virtual Kubernetes clusters
project (tenant k3s behind kcp) uses kcp traditionally.

Port 0 behind the edge: every listener binds port 0 and reports its bound address
into its kcp object status; peers resolve by service name through kcp. Only stable
public edge entry points (caddy 443, an application's front) keep known addresses.

## Parallel tasks: task trees

- Never work cross-repo in a nested worktree (repo/.claude/worktrees/x): siblings do not resolve.
- `./scripts/task-tree.ts new <name> --repos a,b` -> ../publicdomainrelay-kcp-tasks/<name>, org-root-shaped, all real-dir git worktrees.
- `eval "$(./scripts/task-tree.ts env <name>)"`; deno with --node-modules-dir=none; ports/state under $TASK_STATE_DIR; temp files under ~/.tmp (TMPDIR), never /tmp (tmpfs spills to swap).
- Commit/push per repo on task/<name>; commit pointer combos in the task root; `sync` to rebase; `rm` when merged. See docs/task-tree.md.
- One-off scripts: write a .ts file under ~/.tmp and run `deno run -A <file>.ts` (Deno.Command for git/go); no long bash chains or python heredocs.
- Live tests run in the task's own market test bed (isolated fake PLC/relay/PDS/bidders/requesters, port 0), never against the shared real bidder.

## Layers

Every capability ("concept") split 4 ways. Path shows layer:

```
lib/common/${shared}                       leaf utils, types, constants (no concept logic)
lib/abc/${concept}                         interfaces + pure state, zero I/O
lib/${concept}-${transport}                impl: timers, crypto, fetch, sockets
lib/hono-factory-${concept}-${transport}   final Hono integration, composed not subclassed
hono-${concept}                            thin CLI: read config, build factory, serve
```

Deps flow ONE way. No cycles:

```
lib/common/*                  <- external deps ONLY
   ^
lib/abc/*                     <- imports common (type imports)
   ^
lib/${concept}-${transport}   <- imports abc + common
   ^
lib/hono-factory-*            <- imports impl + abc + common + hono
   ^
hono-* (CLI)                  <- imports hono-factory + common + external
```

Org-root `typescript-helpers/` holds cross-repo shared utils (logger, event bus,
cli-args-env, http-error, hono-error-middleware, hono-factory-static-files-fs).
Check there BEFORE writing any new `lib/common/` package. Two repos need it = it
belongs there.

## PATTERNS — ALWAYS DO

- Structured log port via `onListen` when using `Deno.serve`

## ANTI-PATTERNS — NEVER DO

Non-negotiable. Each breaks architecture. Detail + examples below in per-layer
sections.

**Structural**
- Sub-module exports (`exports: { "./sub": ... }`). One package = one `mod.ts`.
- Cross-concept imports (`relayer` imports `subscriber`). Shared -> `lib/common`.
- Package named bare `common`. Use `${concept}-common` or qualifier.
- New transport as flag/if-branch in existing impl. Make sibling package.
- Subclass/extend a Hono factory. Compose; add options or sibling factory.

**Layering**
- I/O in `lib/abc` (timers, fetch, file reads, crypto, `Deno.*`). Pure only.
- `lib/abc` importing an impl (inverted arrow).
- `lib/common` importing anything project-local (abc/impl/factory). External only.
- Cycles in dep graph. `common <- abc <- impl <- factory <- CLI` only.

**CLI/config**
- `Deno.env.get()` in CLI. Use `env` field in `cli-args-env.json`.
- Hardcoded defaults (ports/hosts/paths) in CLI. Use `default` field or `config.json`.
- Hand-parse args or load config. Import `Command` from `@publicdomainrelay/cli-args-env`.

**Cross-repo**
- Duplicate a util already in `typescript-helpers/lib/`. Check first.
- Concept-specific constant/type in `typescript-helpers/`. Single-repo concept
  lives in that repo's `lib/common/${concept}-common`. Only move to
  `typescript-helpers/` when second repo needs it.

**Code style**
- Code comments. Names + types carry meaning.
- Non-ASCII chars unless functional requirement.

### Pre-flight (before writing one line)

1. Belongs in `typescript-helpers/` (cross-repo) or this repo?
2. Which layer? (common / abc / impl / factory / CLI)
3. Importing against the dep arrow?
4. About to write `Deno.env.get()` or hardcode a port?
5. Does a `typescript-helpers/` package already do this?

## License

Unlicense (public domain). See `LICENSE`.

## ABC layering detail

Reader predicts which file holds which code from path alone.

### Layer 0: lib/common

Shared leaf code, zero/minimal deps, no concept logic: wire-format types,
constants, small pure helpers, tiny logger. Anything two concepts need lives
here so neither imports the other.

- Exports wire-contract types (`RelayResponse`, `RelayRequestFrame`).
- Exports constants (NSIDs, service ids), pure helpers (`hostnameOnly`, `didToSubdomain`).
- Tiny logger OK. Nothing that opens a socket or reads a file.
- Imports external packages ONLY, never project-local.
- Two tiers:
  1. **Org-root** `typescript-helpers/lib/` -- cross-repo. Check first.
  2. **Repo-local** `lib/common/${concept}-common` -- types/constants shared by
     concepts in one repo. Name always `${concept}-common`, never bare `common`
     (bare collides with every concept's common layer; dir path `lib/common/`
     stays, package name must be globally unique).

```ts
export const SUBSCRIBE_NSID = "com.example.dispatcher.subscribe";

export function log(
  level: "debug" | "info" | "warn" | "error",
  data: Record<string, unknown>,
): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, ...data });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export function hostnameToDid(hostname: string): string {
  return `did:web:${hostname}`;
}

export interface RelayResponse {
  status: number;
  body: unknown;
  contentType?: string;
}
```

### Layer 1: lib/abc

Pure interfaces, types, state. No I/O, timers, network, side effects. Contract
every impl satisfies + in-memory state machine with no transport opinion.

- Exports interfaces: `NonceStore`, `SubscriberHandle`, `VerifyResult`.
- Exports concrete state classes only if side-effect free -- e.g. `RelayState` =
  Maps + Promise plumbing; actual sending via callback or left to caller.
- Depends on `lib/common` only (usually `type` imports).
- Never imports transport code; never does I/O.

Litmus test "may this live in abc": can you `new` it / call it in a unit test
with no mocks, no fake timers, no network? Yes = belongs here.

```ts
import type { RelayResponse } from "@publicdomainrelay/did-key-ingress-proxy-common";

export interface NonceStore {
  issue(key: string): string;
  verify(reg: { key?: string; nonce?: string }): Promise<VerifyResult>;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  key?: string;
}

export class RelayState {
  readonly subscribers = new Map<string, WebSocket>();
  private pending = new Map<string, (r: RelayResponse) => void>();

  constructor(readonly relayTimeoutMs: number) {}

  handleResponse(requestId: string, status: number, body: unknown): void {
    const resolve = this.pending.get(requestId);
    if (!resolve) return;
    this.pending.delete(requestId);
    resolve({ status, body });
  }
}
```

`RelayState` holds `Map<string, WebSocket>` but never opens/sends on one -- only
stores refs and resolves Promises. Sending done in impl/factory layer. That is
the line between "pure state" and "I/O".

### Layer 2: implementation

Concrete transport binding: timers, crypto, `fetch`, `WebSocket`, `Deno.*`.
Abstract interface from `lib/abc` becomes live thing.

- Implements ABC interfaces -- factory fn returns something satisfying `NonceStore`.
- Uses runtime: `setInterval`, `crypto.getRandomValues`, `Deno.unrefTimer`, `fetch`, sockets.
- Depends on `lib/abc` (interface types) + `lib/common` (utils).
- Named `${concept}-${transport}`, e.g. `did-key-ingress-proxy-xrpc`. Second
  transport = sibling package `did-key-ingress-proxy-grpc`, NOT a flag inside.

```ts
import type { NonceStore, VerifyResult } from "@publicdomainrelay/did-key-ingress-proxy-abc";

export function createNonceStore(ttlMs: number): NonceStore {
  const entries = new Map<string, { key: string; expiresAt: number }>();

  const purge = setInterval(() => {
    const now = Date.now();
    for (const [nonce, e] of entries) if (e.expiresAt < now) entries.delete(nonce);
  }, Math.min(ttlMs, 30_000));
  Deno.unrefTimer?.(purge);

  return {
    issue(key) {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      entries.set(nonce, { key, expiresAt: Date.now() + ttlMs });
      return nonce;
    },
    async verify(reg): Promise<VerifyResult> {
      if (!reg?.nonce) return { ok: false, reason: "missing nonce" };
      const entry = entries.get(reg.nonce);
      if (!entry) return { ok: false, reason: "unknown or expired nonce" };
      entries.delete(reg.nonce);
      return { ok: true, key: reg.key };
    },
  };
}
```

### Layer 3: Hono factory

Final, non-extensible Hono integration. Wraps impl in routes + middleware,
exposes factory fn. Composed, never subclassed -- no "extend further" layer.

- Exports `createXxxFactory(opts)` returning Hono `Factory` whose `.createApp()`
  yields the app. Optional-opt defaults resolved here (`opts.serviceId ?? "xrpc_relay"`).
- Constructs ABC state + impl, wires into routes.
- Depends on impl + ABC + common + Hono. Only CLI depends on it.
- Variant needed = add options or sibling factory. Never subclass.

```ts
import { createFactory } from "@hono/hono/factory";
import { cors } from "@hono/hono/cors";
import { log, hostnameToDid } from "@publicdomainrelay/did-key-ingress-proxy-common";
import { RelayState } from "@publicdomainrelay/did-key-ingress-proxy-abc";
import { createNonceStore } from "@publicdomainrelay/did-key-ingress-proxy-xrpc";

export interface RelayFactoryOptions {
  hostname: string;
  serviceId?: string;
  relayTimeoutMs?: number;
  nonceTtlMs?: number;
}

export function createRelayFactory(opts: RelayFactoryOptions) {
  const serviceId = opts.serviceId ?? "xrpc_relay";
  const state = new RelayState(opts.relayTimeoutMs ?? 30_000);
  const nonceStore = createNonceStore(opts.nonceTtlMs ?? 60_000);

  return createFactory({
    initApp: (app) => {
      app.use("*", cors());
      app.get("/.well-known/did.json", (c) =>
        c.json({
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: hostnameToDid(opts.hostname),
          service: [{ id: `#${serviceId}`, type: "XrpcRelay", serviceEndpoint: `https://${opts.hostname}` }],
        }));
      app.post("/xrpc/issue", async (c) => {
        const input = await c.req.json().catch(() => ({}));
        const nonce = nonceStore.issue(input.key);
        log("info", { component: "relay", event: "nonce_issued", key: input.key });
        return c.json({ nonce });
      });
    },
  });
}
```

### Layer 4: CLI entrypoint

Thin `hono-${concept}/mod.ts`. Import `Command` from
`@publicdomainrelay/cli-args-env`, resolve options, build factory, serve. No
parsing, no env reading, no config loading, no hardcoded defaults -- all in
library + JSON files. See [Standard CLI entrypoint](#standard-cli-entrypoint).

### Adding a new concept

Concept `auth`: one package per layer, register all in root `deno.json`
`workspace[]`:

```
lib/abc/auth/                       @publicdomainrelay/auth-abc            AuthVerifier interface, pure state
lib/auth-oauth/                     @publicdomainrelay/auth-oauth          OAuth impl
lib/auth-atproto/                   @publicdomainrelay/auth-atproto        AT Protocol impl
lib/hono-factory-auth-oauth/        @publicdomainrelay/hono-factory-auth-oauth     Hono middleware wrapping OAuth
lib/hono-factory-auth-atproto/      @publicdomainrelay/hono-factory-auth-atproto   Hono middleware wrapping AT Protocol
hono-auth/  (or fold into existing CLI, e.g. --with-auth=oauth|atproto)
```

Two impls (`oauth`, `atproto`) of same ABC = normal way to offer alternatives:
same interface in `lib/abc/auth`, two sibling impl packages, two sibling
factories. CLI selects.

## CLI config

CLI does no parsing/env reading/config loading. One `new Command(...)` yields
resolved `options`. Every CLI same pattern -- only JSON files + factory wiring
differ.

### cli-args-env.json

Ships with package. Defines every option: name, type, description, optional env
var, optional default. Options keyed by kebab-case name.

```json
{
  "name": "http-static",
  "description": "Static file server",
  "options": {
    "port": {
      "type": "number",
      "description": "Port to listen on",
      "env": "PORT",
      "default": 8080
    },
    "serve-path": {
      "type": "string",
      "description": "Path to serve files from",
      "env": "SERVE_PATH",
      "default": "."
    }
  }
}
```

- Types: `string`, `number`, `boolean`.
- `env` (optional): env var overriding this option.
- `default` (optional): final fallback. Omit if set only by flag/env/config.
- `boolean` = flag: `--flag` sets `true`, absent `false`. No value/env/default.

### config.json

Optional, flat key=value, keys match option names (kebab-case). CLI works
without it. Swap file -- same binary -- to serve multiple environments.

```json
{
  "port": 8080,
  "serve-path": "."
}
```

### Priority chain

First match wins:

```
CLI flag  ->  per-option env var  ->  config.json  ->  cli-args-env.json default
```

`--port 9000` beats `PORT=8080` beats `"port": 8080` (config.json) beats
`"default": 8080` (cli-args-env.json).

### CONFIG_PATH_${NAME} -- swapping config.json

`${NAME}` = CLI dir name, hyphens -> underscores, uppercased:

- `hono-http-static` -> `CONFIG_PATH_HONO_HTTP_STATIC`
- `hono-did-key-ingress-proxy` -> `CONFIG_PATH_HONO_DID_KEY_RELAY_RELAYER`

Point it at replacement `config.json`:

```
CONFIG_PATH_HONO_HTTP_STATIC=/etc/static/prod.json ./static-server
```

Unset = `config.json` resolves module-adjacent (works in `deno run`, JSR cache,
compiled binary VFS).

### Standard CLI entrypoint

Exact shape every CLI follows:

```ts
import { Command } from "@publicdomainrelay/cli-args-env";
import { createStaticFilesApp } from "@publicdomainrelay/hono-factory-static-files-fs";
import cliArgsEnv from "./cli-args-env.json" with { type: "json" };

let runtimeConfig = null;
try {
  const mod = await import("./config.json", { with: { type: "json" } });
  runtimeConfig = mod.default;
} catch { /* optional */ }

const { options } = await new Command(
  "CONFIG_PATH_HONO_HTTP_STATIC",
  cliArgsEnv,
  runtimeConfig,
).resolve();

const app = createStaticFilesApp(options.servePath);

Deno.serve(
  { port: options.port },
  app.fetch,
);
```

`options` is `Record<string, any>`. Access camelCased: `serve-path` ->
`options.servePath`. Explicit-vs-implicit: `options.keypairPath ?? "./keypair.json"`.

### deno compile bundling

List JSON files so they exist in compiled binary VFS:

```json
{
  "compile": {
    "include": ["cli-args-env.json", "config.json"]
  },
  "publish": {
    "include": ["cli-args-env.json"]
  }
}
```

`cli-args-env.json` must be in `publish.include` (JSR serves it). `config.json`
deployment-only -- omit from `publish.include`. In `deno compile`, both bundled
into VFS.

| Execution | Config resolution |
|-----------|-------------------|
| `deno run -A ./mod.ts` | Static/dynamic imports relative to CLI module |
| `deno run -A jsr:@publicdomainrelay/pkg` | Same -- Deno module resolver handles JSR |
| `deno compile` binary | VFS via `compile.include` |
| `CONFIG_PATH_*=...` set | env var path, overrides module-adjacent config.json |

## Packages and workspace

Every package looks same -- adding one = copy-and-adjust, not design.

### Root deno.json

Single workspace lists every member. `nodeModulesDir: "auto"` resolves npm deps;
shared imports in root `imports`.

```json
{
  "nodeModulesDir": "auto",
  "workspace": [
    "./lib/common/did-key-ingress-proxy",
    "./lib/common/cli-args-env",
    "./lib/abc/did-key-ingress-proxy",
    "./lib/abc/did-key-ingress-proxy-subscriber",
    "./lib/did-key-ingress-proxy-xrpc",
    "./lib/did-key-ingress-proxy-subscriber-xrpc",
    "./lib/hono-factory-did-key-ingress-proxy-xrpc",
    "./lib/hono-factory-did-key-ingress-proxy-subscriber-xrpc",
    "./hono-did-key-ingress-proxy",
    "./hono-did-key-ingress-proxy-subscriber"
  ],
  "imports": {
    "@std/assert": "jsr:@std/assert@^1.0.19"
  }
}
```

Every new package added to `workspace[]`. Order by layer (common, abc, impl,
hono-factory, CLI) = readable project map.

### Library package deno.json

Same shape: scoped name, fixed version/license, single `mod.ts` export,
per-package `imports` using `jsr:` for project-local.

```json
{
  "name": "@publicdomainrelay/did-key-ingress-proxy-abc",
  "version": "0.0.0",
  "license": "Unlicense",
  "exports": "./mod.ts",
  "imports": {
    "@publicdomainrelay/did-key-ingress-proxy-common": "jsr:@publicdomainrelay/did-key-ingress-proxy-common@^0"
  }
}
```

- **Single export** `./mod.ts`. No sub-module exports.
- **Scoped name** `@publicdomainrelay/${package-name}`. ABC packages end `-abc`.
- **Project-local imports `jsr:`** at `^0` pre-1.0. Resolve locally because
  package is workspace member.
- `version` `0.0.0` + `license` uniform across packages.

### CLI package deno.json

CLI entrypoints not importable libraries -- omit `name` + `exports`. List
runtime imports + `compile.include` for JSON config.

```json
{
  "version": "0.0.0",
  "license": "Unlicense",
  "imports": {
    "@publicdomainrelay/cli-args-env": "jsr:@publicdomainrelay/cli-args-env@^0",
    "@publicdomainrelay/did-key-ingress-proxy-common": "jsr:@publicdomainrelay/did-key-ingress-proxy-common@^0",
    "@publicdomainrelay/hono-factory-did-key-ingress-proxy-xrpc": "jsr:@publicdomainrelay/hono-factory-did-key-ingress-proxy-xrpc@^0"
  },
  "compile": {
    "include": ["cli-args-env.json", "config.json"]
  }
}
```

### Naming summary

| Layer | Directory | Package name |
|-------|-----------|--------------|
| common | `lib/common/${name}` | `@publicdomainrelay/${concept}-common` or `@publicdomainrelay/${qualifier}` (never bare `common`) |
| abc | `lib/abc/${concept}` | `@publicdomainrelay/${concept}-abc` |
| implementation | `lib/${concept}-${transport}` | `@publicdomainrelay/${concept}-${transport}` |
| hono factory | `lib/hono-factory-${concept}-${transport}` | `@publicdomainrelay/hono-factory-${concept}-${transport}` |
| CLI | `hono-${concept}` | (no name; entrypoint) |

New transport for existing concept = new sibling package
(`${concept}-${transport2}`), never branch/flag inside existing impl. New
concept = fresh set of layers.

### External imports

- Project-local: `jsr:@publicdomainrelay/name@^0`.
- JSR third-party: `jsr:@cliffy/command@^1`, `jsr:@hono/hono`, `jsr:@std/assert@^1`.
- npm when needed (via `nodeModulesDir: "auto"`): `npm:@atproto/api`, `npm:@atproto/crypto`.

Import through bare specifier in `imports` (`@publicdomainrelay/...`,
`@hono/hono`), not inlined `jsr:`/`npm:` URLs -- versions stay centralized in
`deno.json`.

## CLI patterns (ALWAYS)

- `createLogger({ serviceName })` — JSON structured logger for every CLI
- `createServe({ logger, tcp?, unix?, relays? })` — composable serve handle,
  `beginServe()` resolves after relays connect + onConnected hooks fire,
  `shutdown()` via SIGINT/SIGTERM in CLI only
- Provider array: each provider owns its relay + serve + OIDC issuer
  (OIDC mounted on provider's serve in `serve.onConnected`)
- `cliCreateIngress()` — sync constructor, defers WS connect to
  `onServe(fetch)`, `ingressRef` server-assigned → lazy-read everywhere
- `createATProto(...)` — single `atproto` instance passed to providers + bidder
- `createMarketBidder({ providers, ... })` — owns `activeContracts` +
  provider lifecycle (setup/teardown/merge callbacks)
- Signal handlers ONLY in CLI (`Deno.addSignalListener`), never in lib

## CLI patterns (NEVER)

- Raw `Deno.serve()` in CLI or lib — use `createServe()`
- Precompute/eager-read `ingressRef` — always lazy via `() => relay.ingressRef`
- I/O in lib (`Deno.serve`, `Deno.addSignalListener`, `WebSocket` connect,
  `Deno.env.get`) — I/O only in impl layer or CLI
- OIDC bolted on bidder app post-hoc — each provider mounts own OIDC on
  its own serve via `serve.onConnected`
- Single-provider if/else branch — use provider array + hooks pattern
- Port-sniffing (`Deno.listen({port:0})`, read port, close, `Deno.serve({port})`
  on same port) — TOCTOU race. Pass `port: 0` to `Deno.serve`, read bound port
  from `onListen` callback via `Promise.withResolvers`. Same for any
  listen-close-rebind pattern.
