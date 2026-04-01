#!/usr/bin/env bash
set -euo pipefail

# ── Colors ──────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ── Prerequisites ───────────────────────────────────────
if ! command -v bun &>/dev/null; then
  error "bun is required but not found in PATH. Install it from https://bun.sh"
  exit 1
fi

# ── Detect OpenClaw config ──────────────────────────────
OPENCLAW_CONFIG="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"

if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
  error "OpenClaw config not found at ${OPENCLAW_CONFIG}"
  error "Set OPENCLAW_CONFIG_PATH or ensure ~/.openclaw/openclaw.json exists"
  exit 1
fi

info "Using OpenClaw config: ${OPENCLAW_CONFIG}"

# ── Remove ClawMux providers via Bun ────────────────────
bun -e '
const fs = require("fs");
const configPath = process.argv[1];
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

if (!config.models || !config.models.providers) {
  console.log("No providers section found — nothing to remove.");
  process.exit(0);
}

const providers = config.models.providers;
const clawmuxKeys = Object.keys(providers).filter(k => k.startsWith("clawmux-"));

if (clawmuxKeys.length === 0) {
  console.log("No ClawMux providers found — nothing to remove.");
  process.exit(0);
}

for (const key of clawmuxKeys) {
  delete providers[key];
  console.log(`  removed ${key}`);
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log(`\nRemoved ${clawmuxKeys.length} ClawMux provider(s) from openclaw.json`);
' "$OPENCLAW_CONFIG"

echo ""
info "✓ ClawMux provider removal complete!"
