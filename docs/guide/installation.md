# Installation

## Prerequisites

- [OpenClaw](https://github.com/nicepkg/openclaw) installed and configured (`~/.openclaw/openclaw.json`)
- **Bun** (recommended) or **Node.js 18+**

## Quick Install (npm)

```bash
npx clawmux init
```

This will:
1. Detect your OpenClaw config at `~/.openclaw/openclaw.json`
2. Create `clawmux.json` from the default template
3. Register 6 ClawMux providers in your OpenClaw config
4. Install a system service (systemd on Linux, launchd on macOS) for auto-start on boot

ClawMux is now running and will auto-start after reboot.

```bash
clawmux status      # check if running
clawmux stop        # stop the service
clawmux uninstall   # remove service + providers
```

To skip auto-start:

```bash
npx clawmux init --no-service
npx clawmux start   # manual foreground start
```

## Install from Source

```bash
git clone https://github.com/nagle-app/ClawMux
cd ClawMux
bash scripts/install.sh
```

The install script auto-detects your runtime (Bun or Node.js) and installs dependencies accordingly.

### Start the proxy

```bash
# Bun (recommended — faster startup & runtime)
bun run dev        # watch mode (development)
bun run start      # production

# Node.js
npm run start:node # requires tsx: npm i -D tsx
```

### Connect OpenClaw

```bash
openclaw provider clawmux-anthropic
openclaw chat
```

## Runtime Comparison

| | Bun | Node.js |
|---|---|---|
| Startup | ~3s (model load) | ~3s (model load) |
| Classification | ~8ms p50 | ~8ms p50 |
| HTTP Server | `Bun.serve()` native | `node:http` + Web API adapter |
| Install | `bun install` | `npm install` |
| Tests | `bun test` (built-in) | Not supported (test framework is Bun-only) |

Both runtimes use the same codebase. Bun-specific APIs are abstracted via `src/utils/runtime.ts` — the appropriate implementation is selected automatically at startup.

## Registered Providers

After installation, these providers are available in OpenClaw:

| Provider Name | API Format | Use With |
|---|---|---|
| `clawmux-anthropic` | Anthropic Messages | Anthropic, Kimi Coding |
| `clawmux-openai` | OpenAI Completions | OpenAI, Groq, Mistral, xAI, etc. |
| `clawmux-openai-responses` | OpenAI Responses | OpenAI Codex |
| `clawmux-google` | Google Generative AI | Gemini, Vertex |
| `clawmux-ollama` | Ollama | Local models |
| `clawmux-bedrock` | Bedrock | AWS Bedrock |

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `CLAWMUX_PORT` | Proxy server port | `3456` |
| `OPENCLAW_CONFIG_PATH` | Path to openclaw.json | `~/.openclaw/openclaw.json` |

## Uninstall

```bash
bash scripts/uninstall.sh
```

Removes all `clawmux-*` providers from your OpenClaw config. A backup is created before any changes.
