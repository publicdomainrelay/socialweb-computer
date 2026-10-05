#!/usr/bin/env bash
set -xeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORG_ROOT="$(dirname "$SCRIPT_DIR")"

SSH_TARGET="${1}"
SSH_PORT="${SSH_PORT:-22}"
SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes"

remote() {
  ssh ${SSH_OPTS} -p "${SSH_PORT}" "${SSH_TARGET}" "$@"
}

TEMPDIR=$(remote "mktemp -d")
echo "Shipping to ${TEMPDIR}"
tar czf - -C "$ORG_ROOT" \
  --exclude='node_modules' \
  --exclude='.codegraph' \
  --exclude='.cache' \
  --exclude='digitalocean-bidder/data' \
  --exclude='social-web-computer/dist' \
  --exclude='social-web-computer/fancy' \
  --exclude='*.tgz' \
  . | remote "dd bs=16M if=/dev/stdin of=/dev/stdout status=progress | tar -xzf - -C ${TEMPDIR} 2>/dev/null"
echo "Shipped to ${TEMPDIR}"
