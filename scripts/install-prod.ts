#!/usr/bin/env -S deno run --allow-all
// install-prod.ts — deploy + install all prod services for the publicdomainrelay org-root.
//
// Two modes:
//   --local (default on target machine): clone/update repos, install Caddyfile,
//     write systemd units, ensure .env.secrets, enable services, start timers.
//   --deploy: SCP self + Caddyfile to REMOTE_HOST, SSH in, run with --local.
//
// Idempotent: re-running updates repos, refreshes unit files, restarts services.
// Prompts interactively for missing secrets (CHANGE_ME stubs).
//
//   deno run --allow-all scripts/install-prod.ts          # local install
//   deno run --allow-all scripts/install-prod.ts --deploy  # deploy to remote

import { Secp256k1Keypair } from "npm:@atproto/crypto";

// ── constants ────────────────────────────────────────────────────────────────
const HOME = Deno.env.get("HOME")!;
const ORG_ROOT = `${HOME}/prod-org-root`;
const ORG_REPO_URL =
  "https://github.com/publicdomainrelay/org-root-dispatcher-typescript";
const REF_ROOT =
  `${HOME}/prod-compute-contract-reference-implementation-poc`;
const REF_REPO_URL =
  "https://github.com/publicdomainrelay/compute-contract-reference-implementation-poc";
const DENO = `${HOME}/.deno/bin/deno`;
const SYSTEMD_DIR = "/etc/systemd/system";
const CADDY_TARGET = "/etc/caddy/Caddyfile";
const CADDY_DEPLOY_DIR = "/var/www/graph-viewer-0001-fedfork";
const REMOTE_HOST = "mini-cloud-0002.chadig.com";
const REMOTE_PORT = "22";
const REMOTE_USER = "johnandersen777";
const SPA_SOURCE_REL = ".reference/rbac/src/typescript/compute-spa";
const QEMU_RUNNER_IMAGE = "ccripoc-qemu-runner:latest";
const QEMU_RUNNER_DOCKERFILE = `${REF_ROOT}/src/typescript/qemu/qemu-runner.Dockerfile`;
const QEMU_RUNNER_CONTEXT = `${REF_ROOT}/src/typescript/qemu`;

const secretWarnings: string[] = [];

// ── helpers ──────────────────────────────────────────────────────────────────

async function run(cmd: string, ...args: string[]): Promise<void> {
  const c = new Deno.Command(cmd, {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await c.output();
  if (code !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${code}`);
}

async function capture(cmd: string, ...args: string[]): Promise<string> {
  const { stdout } = await new Deno.Command(cmd, { args, stderr: "null" })
    .output();
  return new TextDecoder().decode(stdout).trim();
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function generateKeyHex(): Promise<string> {
  const kp = await Secp256k1Keypair.create({ exportable: true });
  const raw = await kp.export();
  const hex = Array.from(raw)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  raw.fill(0); // zero the extracted private key bytes to shrink the exposure window
  return hex;
}

function parseEnv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const kv = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (kv) m.set(kv[1], kv[2]);
  }
  return m;
}

/** Read a single line from stdin (prompt). */
async function promptLine(msg: string): Promise<string> {
  await Deno.stdout.write(new TextEncoder().encode(msg));
  const buf = new Uint8Array(4096);
  const n = await Deno.stdin.read(buf);
  if (n === null) return "";
  return new TextDecoder().decode(buf.subarray(0, n)).trim();
}

// ── unit / env definitions ──────────────────────────────────────────────────

interface UnitDef {
  name: string;
  description: string;
  workingDir: string;
  execStart: string;
  after?: string;
  wants?: string;
  envFiles?: string[];
  extraEnv?: [string, string][];
  type?: string; // default "simple"
  restart?: string; // default "on-failure"
}

interface EnvDef {
  path: string; // relative to a root (ORG_ROOT or REF_ROOT)
  vars: [string, string][]; // [KEY, value-or-CHANGE_ME]
  root: "org" | "ref";
}

const PATH_ENV =
  `${HOME}/.deno/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

const UNITS: UnitDef[] = [
  {
    name: "atproto-relay.service",
    description: "atproto-relay (relay.mini-cloud-0002.chadig.com)",
    workingDir: `${ORG_ROOT}/atproto-relay/hono-atproto-relay`,
    execStart: `${DENO} run --allow-all mod.ts`,
    after: "network-online.target",
    wants: "network-online.target",
    envFiles: [
      `${ORG_ROOT}/atproto-relay/hono-atproto-relay/atproto-relay.env`,
      `${ORG_ROOT}/atproto-relay/hono-atproto-relay/atproto-relay.env.secrets`,
    ],
  },
  {
    name: "bidder.service",
    description: "fedfork bidder (org-root, local VM mode)",
    workingDir: `${ORG_ROOT}/atproto-market/hono-bidder`,
    execStart:
      `${DENO} run --allow-all mod.ts --compute-provider-local --compute-provider-local-container-mode=vm`,
    after: "network-online.target",
    wants: "network-online.target",
    envFiles: [
      `${ORG_ROOT}/atproto-market/hono-bidder/bidder.env`,
      `${ORG_ROOT}/atproto-market/hono-bidder/bidder.env.secrets`,
    ],
  },
  {
    name: "hono-jsr.service",
    description: "hono-jsr package registry (jsr.publicdomainrelay.com)",
    workingDir: `${ORG_ROOT}/hono-jsr/hono-package-registry`,
    execStart:
      `${DENO} run --allow-all main.ts --port=8888 --store=git --git-url=${ORG_REPO_URL}`,
    after: "network-online.target",
    wants: "network-online.target",
  },
  {
    name: "git-pull.service",
    description: "git pull org-root + rebuild compute-spa",
    workingDir: ORG_ROOT,
    execStart: `${HOME}/bin/git-pull-and-rebuild.sh`,
    after: "network-online.target",
    wants: "network-online.target",
    type: "oneshot",
  },
  {
    name: "git-pull.timer",
    description: "trigger git-pull every 5 minutes",
    workingDir: ORG_ROOT,
    execStart: "", // timer-only unit, no ExecStart
    type: "timer",
  },
];

const ENV_FILES: EnvDef[] = [
  {
    path: "atproto-relay/hono-atproto-relay/atproto-relay.env",
    root: "org",
    vars: [
      ["HOSTNAME", "relay.mini-cloud-0002.chadig.com"],
      ["PORT", "2584"],
    ],
  },
  {
    path: "atproto-market/hono-bidder/bidder.env",
    root: "org",
    vars: [
      ["INGRESS_PROXY_HOST", "xrpc.fedproxy.com"],
      ["RELAY_URL", "https://relay.mini-cloud-0002.chadig.com"],
      ["PLC_DIRECTORY_URL", "https://plc.directory"],
      ["COMPUTE_PROVIDER_LOCAL_CONTAINER_MODE", "vm"],
      ["COMPUTE_PROVIDER_LOCAL_VM_IMAGE", QEMU_RUNNER_IMAGE],
      ["COMPUTE_PROVIDER_LOCAL_CACHE_DIR", `${HOME}/.cache/pdr-local`],
      ["OFFERING_REFRESH_SEC", "300"],
      ["FIREHOSE_MODE", "subscriberepos"],
    ],
  },
];

// ── deno ─────────────────────────────────────────────────────────────────────

async function ensureDeno(): Promise<void> {
  if (await exists(DENO)) {
    console.log(`Deno found at ${DENO}`);
    return;
  }
  console.log("Installing Deno …");
  await run(
    "sh",
    "-c",
    `curl -fsSL https://deno.land/install.sh | DENO_INSTALL=${HOME}/.deno sh`,
  );
  if (!(await exists(DENO))) {
    throw new Error(`Deno not found at ${DENO} after install`);
  }
}

// ── repos ────────────────────────────────────────────────────────────────────

async function ensureRepo(root: string, url: string): Promise<void> {
  if (await exists(`${root}/.git`)) {
    console.log(`Updating ${root} …`);
    await run("git", "-C", root, "fetch", "origin", "main");
    await run("git", "-C", root, "reset", "--hard", "origin/main");
    await run("git", "-C", root, "submodule", "update", "--init", "--recursive");
  } else {
    console.log(`Cloning ${url} → ${root} …`);
    await run("git", "clone", "--recurse-submodules", url, root);
  }
}

// ── secrets ──────────────────────────────────────────────────────────────────

/**
 * For each env file with CHANGE_ME stubs, ensure a sibling .env.secrets exists.
 * Prompts interactively for any still-unset values.
 */
async function ensureSecrets(): Promise<void> {
  console.log("\n==> Checking .env.secrets files …\n");
  for (const def of ENV_FILES) {
    const root = def.root === "org" ? ORG_ROOT : REF_ROOT;
    const envFile = `${root}/${def.path}`;
    if (!(await exists(envFile))) {
      console.log(`  SKIP ${envFile} (not found)`);
      continue;
    }

    const stubVars = [...parseEnv(await Deno.readTextFile(envFile))]
      .filter(([, v]) => v === "CHANGE_ME")
      .map(([k]) => k);

    const secretsFile = `${envFile}.secrets`;
    if (stubVars.length > 0 || (await exists(secretsFile))) {
      const existing = (await exists(secretsFile))
        ? parseEnv(await Deno.readTextFile(secretsFile))
        : new Map<string, string>();

      let dirty = false;
      for (const k of stubVars) {
        const cur = existing.get(k);
        if (cur !== undefined && cur !== "CHANGE_ME") continue;

        // 1) shell env
        const fromEnv = Deno.env.get(k);
        if (fromEnv) {
          existing.set(k, fromEnv);
          dirty = true;
          console.log(`  ${def.path}.secrets: ${k} <- shell env`);
          continue;
        }

        // 2) _KEY_HEX suffix → generate
        if (k.endsWith("_KEY_HEX")) {
          existing.set(k, await generateKeyHex());
          dirty = true;
          console.log(`  ${def.path}.secrets: ${k} <- generated k256 key`);
          continue;
        }

        // 3) prompt
        console.log(`\n  ── ${def.path} ──`);
        const val = await promptLine(`  Enter ${k}: `);
        if (val) {
          existing.set(k, val);
          dirty = true;
        } else {
          existing.set(k, "CHANGE_ME");
          secretWarnings.push(`${secretsFile} needs a real value for ${k}`);
        }
      }

      if (dirty || !(await exists(secretsFile))) {
        const body = [...existing]
          .map(([k, v]) => `${k}=${v}`)
          .join("\n") + "\n";
        await Deno.writeTextFile(secretsFile, body, { mode: 0o600 });
        await Deno.chmod(secretsFile, 0o600);
      }

      // Purge secrets entries whose keys no longer appear in the main env file
      const envKeys = new Set(parseEnv(await Deno.readTextFile(envFile)).keys());
      let secretsPurged = false;
      for (const k of existing.keys()) {
        if (!envKeys.has(k)) {
          existing.delete(k);
          secretsPurged = true;
        }
      }
      if (secretsPurged) {
        if (existing.size > 0) {
          const body = [...existing]
            .map(([k, v]) => `${k}=${v}`)
            .join("\n") + "\n";
          await Deno.writeTextFile(secretsFile, body, { mode: 0o600 });
          await Deno.chmod(secretsFile, 0o600);
        } else {
          // All entries purged — remove the secrets file entirely
          await Deno.remove(secretsFile).catch(() => {});
        }
        console.log(`  purged stale secrets from ${def.path}.secrets`);
      }
    }
  }
}

// ── systemd units ────────────────────────────────────────────────────────────

function writeTimerUnit(def: UnitDef): string {
  return `[Unit]
Description=${def.description}

[Timer]
OnBootSec=2min
OnCalendar=*:0/5
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function writeServiceUnit(def: UnitDef): string {
  const lines: string[] = [];
  lines.push("[Unit]");
  lines.push(`Description=${def.description}`);
  if (def.after) lines.push(`After=${def.after}`);
  if (def.wants) lines.push(`Wants=${def.wants}`);
  lines.push("");
  lines.push("[Service]");
  lines.push(`Type=${def.type ?? "simple"}`);
  lines.push(`SyslogIdentifier=${def.name.replace(".service", "")}`);
  lines.push(`User=${REMOTE_USER}`);
  lines.push(`WorkingDirectory=${def.workingDir}`);
  lines.push(`Environment=HOME=${HOME}`);
  lines.push(`Environment=PATH=${PATH_ENV}`);
  for (const f of def.envFiles ?? []) {
    lines.push(`EnvironmentFile=-${f}`);
  }
  for (const [k, v] of def.extraEnv ?? []) {
    lines.push(`Environment=${k}=${v}`);
  }
  lines.push(`ExecStart=${def.execStart}`);
  lines.push(`Restart=${def.restart ?? "on-failure"}`);
  lines.push("RestartSec=5");
  lines.push("KillMode=mixed");
  lines.push("");
  lines.push("[Install]");
  lines.push("WantedBy=multi-user.target");
  return lines.join("\n") + "\n";
}

async function installUnits(): Promise<void> {
  console.log("\n==> Installing systemd units …\n");
  for (const def of UNITS) {
    const content = def.type === "timer"
      ? writeTimerUnit(def)
      : writeServiceUnit(def);
    const dest = `${SYSTEMD_DIR}/${def.name}`;
    // Only write if different (idempotent)
    const existing = await exists(dest)
      ? await Deno.readTextFile(dest)
      : "";
    if (existing !== content) {
      console.log(`  write ${dest}`);
      const tmp = `/tmp/${def.name}`;
      await Deno.writeTextFile(tmp, content);
      await run("sudo", "cp", tmp, dest);
      await Deno.remove(tmp);
    } else {
      console.log(`  skip ${dest} (unchanged)`);
    }
  }
}

// ── caddy install ────────────────────────────────────────────────────────────

async function ensureCaddy(): Promise<void> {
  console.log("\n==> Ensuring Caddy with cloudflare DNS module …\n");
  await run(
    "bash",
    "-c",
    `
set -euo pipefail

if caddy list-modules 2>/dev/null | grep -q 'dns.providers.cloudflare'; then
  echo "Caddy already has dns.providers.cloudflare -- skipping build"
  exit 0
fi

echo "cloudflare DNS module missing -- installing Caddy + building with xcaddy"
sudo apt-get update
# Fix any broken dpkg state from prior interrupted installs
sudo DEBIAN_FRONTEND=noninteractive dpkg --configure -a || true
sudo DEBIAN_FRONTEND=noninteractive apt-get install -f -y || true

if ! command -v caddy >/dev/null 2>&1; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Options::="--force-confold" caddy
fi

command -v go >/dev/null 2>&1 || sudo apt-get install -y golang-go

if ! command -v xcaddy >/dev/null 2>&1; then
  wget -q "https://github.com/caddyserver/xcaddy/releases/download/v0.4.5/xcaddy_0.4.5_linux_amd64.deb" -O /tmp/xcaddy.deb
  sudo dpkg -i /tmp/xcaddy.deb
fi

xcaddy build --with github.com/caddy-dns/cloudflare --output /tmp/caddy-cloudflare
sudo mv /tmp/caddy-cloudflare /usr/bin/caddy
sudo chmod 0755 /usr/bin/caddy

caddy list-modules 2>/dev/null | grep -q 'dns.providers.cloudflare' || { echo "ERROR: cloudflare DNS module still missing after build"; exit 1; }
echo "Caddy now has dns.providers.cloudflare"
`,
  );
}

// ── VM images ────────────────────────────────────────────────────────────────

async function ensureVmImages(): Promise<void> {
  console.log("\n==> Building VM images …\n");

  // Build qemu-runner from the reference repo Dockerfile so we don't
  // depend on atcr.io (ATCR requires AT Protocol auth for pulls).
  if (!(await exists(QEMU_RUNNER_DOCKERFILE))) {
    console.log(`  SKIP: ${QEMU_RUNNER_DOCKERFILE} not found (ref repo not cloned yet?)`);
    return;
  }

  const imageId = await capture("docker", "images", "-q", QEMU_RUNNER_IMAGE).catch(() => "");
  if (!imageId) {
    console.log(`  building ${QEMU_RUNNER_IMAGE} …`);
    await run("docker", "build",
      "--pull",
      "-f", QEMU_RUNNER_DOCKERFILE,
      "-t", QEMU_RUNNER_IMAGE,
      QEMU_RUNNER_CONTEXT,
    );
  } else {
    console.log(`  ${QEMU_RUNNER_IMAGE} already built`);
  }

  // Also ensure container-runner-ubuntu gets built — the compute provider
  // builds it on first use, but we can force a build now.
  const crTag = "container-runner-ubuntu:latest";
  const crId = await capture("docker", "images", "-q", crTag).catch(() => "");
  if (!crId) {
    console.log(`  ${crTag} will be built on first provisioning (cold start OK)`);
  }

  // Pre-create cache dir so the compute provider doesn't fail on first
  // provisioning with a missing directory.
  const cacheDir = `${HOME}/.cache/pdr-local`;
  await Deno.mkdir(cacheDir, { recursive: true });
  console.log(`  cache dir ${cacheDir} ready`);

  // Pre-build the VM guest image (squashfs, kernel, initrd) so the first
  // RFP provision doesn't wait for a full OS build. qemu-standalone.ts
  // caches artifacts in /root/.cache/simple-qemu inside the container.
  const buildSentinel = `${cacheDir}/.build-complete`;
  if (await exists(buildSentinel)) {
    console.log("  VM guest image cache already warm");
  } else {
    // Pre-build runs in background — takes 5-10 min (chroot, kernel, squashfs).
    // First RFP provision will block until this completes.
    console.log("  starting VM guest image pre-build in background …");
    const child = new Deno.Command("docker", {
      args: ["run", "--rm", "--privileged",
        "-v", `${cacheDir}:/root/.cache/simple-qemu`,
        "--entrypoint", "deno",
        QEMU_RUNNER_IMAGE,
        "run", "-A", "qemu-standalone.ts", "build", "--distro=ubuntu",
      ],
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    // Fire-and-forget: don't block deploy on pre-build
    child.status.then(() => Deno.writeTextFile(buildSentinel, "")).catch(() => {});
  }
}

// ── caddy user + runtime dirs ────────────────────────────────────────────────

/** The caddy deb normally creates the caddy user, but broken dpkg can skip it. */
async function ensureCaddyUser(): Promise<void> {
  try {
    await capture("id", "caddy");
  } catch {
    await run("sudo", "useradd", "-r", "-d", "/var/lib/caddy", "-s", "/usr/sbin/nologin", "caddy");
    console.log("  created caddy user");
  }
  await run("sudo", "mkdir", "-p", "/opt/caddy");
  await run("sudo", "chown", "-R", "caddy:caddy", "/opt/caddy");
}

// ── Caddyfile ────────────────────────────────────────────────────────────────

const CADDYFILE_CONTENT = `# Caddyfile — managed by scripts/install-prod.ts
# Installed to /etc/caddy/Caddyfile

{
\tadmin unix//opt/caddy/caddy-admin.sock
}

# --- atproto-relay ---
https://relay.mini-cloud-0002.chadig.com {
\treverse_proxy http://127.0.0.1:2584
}

# --- compute provider OIDC issuer ---
https://mini-cloud-0002.fedfork.com {
\treverse_proxy http://127.0.0.1:9000
}
`;

async function installCaddyfile(): Promise<void> {
  console.log("\n==> Installing Caddyfile …\n");
  const existing = await exists(CADDY_TARGET)
    ? await Deno.readTextFile(CADDY_TARGET)
    : "";
  if (existing !== CADDYFILE_CONTENT) {
    const tmp = "/tmp/Caddyfile";
    await Deno.writeTextFile(tmp, CADDYFILE_CONTENT);
    await run("sudo", "mkdir", "-p", CADDY_TARGET.substring(0, CADDY_TARGET.lastIndexOf("/")));
    await run("sudo", "cp", tmp, CADDY_TARGET);
    await Deno.remove(tmp);
    console.log(`  wrote ${CADDY_TARGET}`);
    console.log("  reloading caddy …");
    await run("sudo", "systemctl", "reload", "caddy");
  } else {
    console.log(`  skip ${CADDY_TARGET} (unchanged)`);
  }
}

// ── git-pull-and-rebuild script ──────────────────────────────────────────────

const GIT_PULL_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME}"
ORG_ROOT="\${HOME}/prod-org-root"
SPA_SRC="\${ORG_ROOT}/${SPA_SOURCE_REL}"
DEPLOY_DIR="${CADDY_DEPLOY_DIR}"

# npm may be installed via nvm; ensure it's on PATH
export NVM_DIR="\${HOME}/.config/nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"

cd "\${ORG_ROOT}"

BEFORE=\$(git rev-parse HEAD 2>/dev/null || echo "none")
git fetch origin main
git reset --hard origin/main
git submodule update --init --recursive
AFTER=\$(git rev-parse HEAD)

if [ "\$BEFORE" != "\$AFTER" ]; then
  echo "[git-pull] new commits: \${BEFORE:0:7} → \${AFTER:0:7}"

  if [ -f "\${SPA_SRC}/package.json" ]; then
    echo "[git-pull] rebuilding compute-spa …"
    cd "\${SPA_SRC}"

    npm install --no-audit --no-fund
    npm run build

    if [ -d dist ]; then
      echo "[git-pull] deploying to \${DEPLOY_DIR} …"
      sudo mkdir -p "\${DEPLOY_DIR}"
      rm -rf /tmp/graph-viewer-deploy
      cp -r dist /tmp/graph-viewer-deploy
      sudo rm -rf "\${DEPLOY_DIR:?}"/*
      sudo cp -r /tmp/graph-viewer-deploy/* "\${DEPLOY_DIR}/"
      sudo chown -R caddy:caddy "\${DEPLOY_DIR}"
      rm -rf /tmp/graph-viewer-deploy
      echo "[git-pull] deploy complete"
    else
      echo "[git-pull] WARNING: no dist/ after build"
    fi
  fi
else
  echo "[git-pull] no new commits"
fi
`;

async function installGitPullScript(): Promise<void> {
  const dest = `${HOME}/bin/git-pull-and-rebuild.sh`;
  console.log(`  writing ${dest}`);
  await Deno.mkdir(`${HOME}/bin`, { recursive: true });
  await Deno.writeTextFile(dest, GIT_PULL_SCRIPT);
  await Deno.chmod(dest, 0o755);
}

// ── env files ────────────────────────────────────────────────────────────────

async function writeEnvFiles(): Promise<void> {
  console.log("\n==> Writing .env files …\n");
  for (const def of ENV_FILES) {
    const root = def.root === "org" ? ORG_ROOT : REF_ROOT;
    const filePath = `${root}/${def.path}`;
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    await Deno.mkdir(dir, { recursive: true });

    // Read existing to preserve custom vars not in our definition
    const existing = (await exists(filePath))
      ? parseEnv(await Deno.readTextFile(filePath))
      : new Map<string, string>();

    // Merge: new vars always set; existing keys preserved unless we're overriding
    for (const [k, v] of def.vars) {
      if (!existing.has(k) || v !== "CHANGE_ME") {
        existing.set(k, v);
      }
    }

    // Purge stale CHANGE_ME entries no longer in the current definition
    const defKeys = new Set(def.vars.map(([k]) => k));
    for (const [k, v] of existing) {
      if (v === "CHANGE_ME" && !defKeys.has(k)) {
        existing.delete(k);
      }
    }

    const body = [...existing]
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
    const current = await exists(filePath)
      ? await Deno.readTextFile(filePath)
      : "";
    if (current !== body) {
      console.log(`  write ${filePath}`);
      await Deno.writeTextFile(filePath, body);
    } else {
      console.log(`  skip ${filePath} (unchanged)`);
    }
  }
}

// ── /etc/hosts ───────────────────────────────────────────────────────────────

/**
 * Services using HOSTNAME env var bind Deno.serve to the public hostname,
 * which doesn't resolve locally. Map service hostnames to loopback so
 * Deno.serve() doesn't fail with "Name or service not known".
 */
async function ensureHostsEntries(): Promise<void> {
  const hostsFile = "/etc/hosts";
  const entries: [string, string][] = [
    ["127.0.0.1", "relay.mini-cloud-0002.chadig.com"],
  ];
  let contents = await Deno.readTextFile(hostsFile);
  let changed = false;
  for (const [ip, host] of entries) {
    if (!contents.split("\n").some((l) => l.includes(ip) && l.includes(host))) {
      contents += `\n${ip} ${host}\n`;
      console.log(`  adding ${ip} ${host} to ${hostsFile}`);
      changed = true;
    }
  }
  if (!changed) {
    console.log(`  ${hostsFile} entries already present`);
    return;
  }
  const tmp = "/tmp/hosts";
  await Deno.writeTextFile(tmp, contents);
  await run("sudo", "cp", tmp, hostsFile);
  await Deno.remove(tmp);
}

// ── caddy systemd unit ──────────────────────────────────────────────────────

/** Write the caddy systemd unit (without CF_API_TOKEN — no DNS-01 needed). */
async function installCaddyUnit(): Promise<void> {
  const unitFile = "/usr/lib/systemd/system/caddy.service";

  const content = `[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=root
Group=root
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
LimitNPROC=512
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
`;

  const existing = (await exists(unitFile))
    ? await Deno.readTextFile(unitFile)
    : "";
  if (existing !== content) {
    const tmp = "/tmp/caddy.service";
    await Deno.writeTextFile(tmp, content);
    await run("sudo", "cp", tmp, unitFile);
    await Deno.remove(tmp);
    console.log(`  wrote ${unitFile}`);
  } else {
    console.log(`  skip ${unitFile} (unchanged)`);
  }
}

// ── enable & start ───────────────────────────────────────────────────────────

async function tryRun(cmd: string, ...args: string[]): Promise<boolean> {
  try {
    await run(cmd, ...args);
    return true;
  } catch (e) {
    console.error(`  WARN: ${(e as Error).message}`);
    return false;
  }
}

async function enableUnits(): Promise<void> {
  console.log("\n==> Enabling & starting units …\n");
  await run("sudo", "systemctl", "daemon-reload");

  for (const def of UNITS) {
    if (def.type === "timer") {
      console.log(`  enable --now ${def.name}`);
      await tryRun("sudo", "systemctl", "enable", "--now", def.name);
    } else if (def.name.endsWith(".service")) {
      console.log(`  enable --now ${def.name}`);
      await tryRun("sudo", "systemctl", "enable", "--now", def.name);
      await tryRun("sudo", "systemctl", "restart", def.name);
    }
  }

  // Reload caddy after all backends are up
  console.log("\n  reloading caddy …");
  await tryRun("sudo", "systemctl", "reload", "caddy");
}

async function showStatus(): Promise<void> {
  console.log("\n==> Service status …\n");
  for (const def of UNITS) {
    if (def.name.endsWith(".timer")) continue;
    console.log(
      await capture(
        "systemctl",
        "--no-pager",
        "--lines=0",
        "status",
        def.name,
      ),
    );
    console.log("");
  }
}

// ── deploy (remote) ──────────────────────────────────────────────────────────

async function deployRemote(): Promise<void> {
  const self = new URL(import.meta.url).pathname;

  console.log(`Deploying to ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PORT} …`);

  // SCP self to remote
  await run(
    "scp",
    "-P",
    REMOTE_PORT,
    "-o",
    "StrictHostKeyChecking=accept-new",
    self,
    `${REMOTE_USER}@${REMOTE_HOST}:/tmp/`,
  );

  // SSH → run local install (inline Caddyfile + units are self-contained)
  await run(
    "ssh",
    "-p",
    REMOTE_PORT,
    "-o",
    "StrictHostKeyChecking=accept-new",
    `${REMOTE_USER}@${REMOTE_HOST}`,
    `$HOME/.deno/bin/deno run --allow-all /tmp/install-prod.ts --local`,
  );

  console.log("\nDeploy complete.");
}

// ── main ─────────────────────────────────────────────────────────────────────

async function localInstall(): Promise<void> {
  console.log("=== install-prod (local) ===\n");

  await ensureDeno();
  await ensureCaddy();
  await ensureHostsEntries();
  await ensureRepo(ORG_ROOT, ORG_REPO_URL);
  await ensureRepo(REF_ROOT, REF_REPO_URL);
  await ensureVmImages();
  await writeEnvFiles();
  await ensureSecrets();
  await installGitPullScript();
  await installUnits();
  await installCaddyfile();
  await ensureCaddyUser();
  await installCaddyUnit();
  await run("sudo", "systemctl", "daemon-reload");
  await tryRun("sudo", "systemctl", "enable", "--now", "caddy");
  await enableUnits();
  await showStatus();

  if (secretWarnings.length > 0) {
    console.log(
      "==> WARNING: unset secrets left as CHANGE_ME " +
        "(re-run or edit .env.secrets files):",
    );
    for (const w of secretWarnings) console.log(`  ${w}`);
  }

  console.log(
    "\nDone. Tail logs: journalctl -u atproto-relay -u bidder -u hono-jsr -u spindle -f",
  );
}

// ── entry ────────────────────────────────────────────────────────────────────

const args = Deno.args.map((a) => a.trim()).filter(Boolean);

if (args.includes("--deploy") || args.includes("-d")) {
  await deployRemote();
} else {
  await localInstall();
}
