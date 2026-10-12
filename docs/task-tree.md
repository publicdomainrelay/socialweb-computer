# Task trees: parallel work across the polyrepo

`scripts/task-tree.ts` builds an org-root-shaped directory per task, so several
agents can work in parallel without touching the main checkout.

Why: a nested worktree of one repo (`atproto-market/.claude/worktrees/x`) cannot
resolve siblings (`deno.json` maps `@publicdomainrelay/...` to
`../typescript-helpers/...`, `deno-kcp/go.mod` has `replace ... => ../kcp-libs`),
cross-repo tasks need several branches together, and symlinked siblings are
refused by `Deno.readDir`. A task tree fixes all three.

## Layout

```
../publicdomainrelay-kcp-tasks/<name>/   git worktree of org root, branch task/<name>
  atproto-market/                         git worktree of ./atproto-market, branch task/<name>
  typescript-helpers/                     git worktree, branch task/<name>
  deno-kcp/                               git worktree, detached at origin/main
    third_party/openbao/                  git worktree, detached at deno-kcp's gitlink
  ...                                     every initialized submodule, real directories
```

Every directory is a `git worktree` from the main checkout, so objects are
shared and creation takes about a second. Main checkouts' working trees and
branches are never changed (only `origin/*` refs are fetched and `task/<name>`
branches are created). `git status` in the task root shows submodule pointers
that differ from the task branch as modified; commit them on `task/<name>` to
record a pointer combo.

## Usage

```bash
./scripts/task-tree.ts new wave0 --repos atproto-market,typescript-helpers
eval "$(./scripts/task-tree.ts env wave0)"
cd "$(./scripts/task-tree.ts path wave0 atproto-market)"
deno check --node-modules-dir=none hono-bidder/mod.ts
./scripts/task-tree.ts add wave0 hono-pds
./scripts/task-tree.ts status wave0 | yq -P
./scripts/task-tree.ts sync wave0
git -C "$(./scripts/task-tree.ts path wave0 atproto-market)" push -u origin task/wave0
./scripts/task-tree.ts rm wave0
```

| command | effect |
|---|---|
| `new <name> [--repos a,b] [--base main] [--root dir]` | fetch, then create the tree; named repos get `task/<name>` from `origin/<base>`, others are detached at `origin/main`, nested submodules at their gitlink. Refuses an existing name or a root inside the org root. |
| `add <name> <repo...>` | turn a detached sibling into branch `task/<name>` at its current HEAD |
| `status [<name>]` | JSON per repo: mode, branch, dirty, pointers, ahead/behind `origin/<base>`, unpushed, pushed; all tasks when no name |
| `sync <name>` | fetch, rebase task branches onto `origin/<base>` (stops at the first conflict, exit 1), fast-forward detached siblings |
| `rm <name> [--force]` | refuses dirty or unpushed work; removes all worktrees, prunes, deletes `task/<name>` branches that are merged into `origin/<base>` (all with `--force`) |
| `env <name>` | shell exports: `TASK_ROOT`, `TASK_STATE_DIR=$XDG_STATE_HOME/swc-tasks/<name>`, shared `DENO_DIR`, `DENO_NO_UPDATE_CHECK=1`, `TASK_DENO_FLAGS=--node-modules-dir=none` |
| `path <name> [repo]` | absolute path of the tree or one repo |

Run deno with `--node-modules-dir=none` inside a tree so it does not create a
`node_modules/` per tree. Use `TASK_STATE_DIR` for ports, logs and other
per-task state. Each task's manifest (repos, base, timings) is
`$TASK_STATE_DIR/task.json`; `new`/`sync`/`rm` events are appended to
`$XDG_STATE_HOME/swc-tasks/history.jsonl`.

Global flag `--org-root <dir>` selects the main checkout; by default it is the
main checkout that owns the script, also when the script is run from inside a
task tree.

Tests: `cd scripts && deno test -A task_tree_test.ts`.
