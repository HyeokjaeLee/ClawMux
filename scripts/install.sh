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

# ── Backup config ───────────────────────────────────────
BACKUP_PATH="${OPENCLAW_CONFIG}.bak.$(date +%s)"
cp "$OPENCLAW_CONFIG" "$BACKUP_PATH"
info "Backup created: ${BACKUP_PATH}"

# ── Create clawmux.json from example if missing ─────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CLAWMUX_JSON="${PROJECT_ROOT}/clawmux.json"
CLAWMUX_EXAMPLE="${PROJECT_ROOT}/clawmux.example.json"

if [[ ! -f "$CLAWMUX_JSON" ]]; then
  if [[ -f "$CLAWMUX_EXAMPLE" ]]; then
    cp "$CLAWMUX_EXAMPLE" "$CLAWMUX_JSON"
    info "Created clawmux.json from clawmux.example.json"
  else
    warn "clawmux.json not found and no clawmux.example.json to copy from"
  fi
fi

# ── Register providers via Bun ──────────────────────────
bun -e '
const fs = require("fs");
const configPath = process.argv[1];
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

if (!config.models) config.models = {};
if (!config.models.providers) config.models.providers = {};

const providers = config.models.providers;
let added = 0;

const entries = [
  {
    key: "clawmux-anthropic",
    value: {
      baseUrl: "http://localhost:3456",
      api: "anthropic-messages",
      models: [{ id: "auto", name: "ClawMux Auto Router" }]
    }
  },
  {
    key: "clawmux-openai",
    value: {
      baseUrl: "http://localhost:3456",
      api: "openai-completions",
      models: [{ id: "auto", name: "ClawMux Auto Router" }]
    }
  },
  {
    key: "clawmux-openai-responses",
    value: {
      baseUrl: "http://localhost:3456",
      api: "openai-responses",
      models: [{ id: "auto", name: "ClawMux Auto Router" }]
    }
  },
  {
    key: "clawmux-google",
    value: {
      baseUrl: "http://localhost:3456",
      api: "google-generative-ai",
      models: [{ id: "auto", name: "ClawMux Auto Router" }]
    }
  },
  {
    key: "clawmux-ollama",
    value: {
      baseUrl: "http://localhost:3456",
      api: "ollama",
      models: [{ id: "auto", name: "ClawMux Auto Router" }]
    }
  },
  {
    key: "clawmux-bedrock",
    value: {
      baseUrl: "http://localhost:3456",
      api: "bedrock-converse-stream",
      models: [{ id: "auto", name: "ClawMux Auto Router" }]
    }
  }
];

for (const { key, value } of entries) {
  if (providers[key]) {
    console.log(`  skip  ${key} (already exists)`);
  } else {
    providers[key] = value;
    added++;
    console.log(`  added ${key}`);
  }
}

if (added > 0) {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log(`\nAdded ${added} provider(s) to openclaw.json`);
} else {
  console.log("\nAll ClawMux providers already registered — nothing to do.");
}
' "$OPENCLAW_CONFIG"

echo ""
info "✓ ClawMux provider registration complete!"
echo ""
echo "Next steps:"
echo "  1. Start ClawMux:       bun run dev"
echo "  2. Select a provider:    openclaw provider clawmux-openai"
echo "  3. Start chatting:       openclaw chat"
