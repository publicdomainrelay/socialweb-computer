#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/merge-task.sh <task> <repo>... [-- <pointer commit message>]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
task="$1"
shift
repos=()
msg=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    msg="$*"
    break
  fi
  repos+=("$1")
  shift
done
[ ${#repos[@]} -ge 1 ] || usage

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

for r in "${repos[@]}"; do
  git -C "$r" checkout -q -- deno.lock 2>/dev/null || true
  git -C "$r" fetch -q origin
  git -C "$r" checkout -q main
  git -C "$r" pull -q --ff-only origin main
  git -C "$r" branch -q -f tmp-merge "origin/task/$task"
  if ! git -C "$r" rebase -q main tmp-merge; then
    git -C "$r" rebase --abort || true
    git -C "$r" checkout -q main
    git -C "$r" branch -q -D tmp-merge
    echo "{\"repo\":\"$r\",\"task\":\"$task\",\"result\":\"conflict\"}"
    exit 1
  fi
  git -C "$r" checkout -q main
  git -C "$r" merge -q --ff-only tmp-merge
  git -C "$r" branch -q -D tmp-merge
  git -C "$r" push -q origin main
  echo "{\"repo\":\"$r\",\"task\":\"$task\",\"main\":\"$(git -C "$r" rev-parse --short HEAD)\"}"
done

git pull -q --rebase origin main
git add "${repos[@]}"
if ! git diff --cached --quiet; then
  git commit -q -m "${msg:-submodules: merge task/$task}

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Mj6uPEBTPoTVeyuNmvKfU9"
  git push -q origin main
fi
echo "{\"org-root\":\"$(git rev-parse --short HEAD)\"}"
