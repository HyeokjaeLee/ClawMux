# ClawMux

Smart model routing + context compression proxy for OpenClaw. Zero dependencies.

## Features

- 🧠 **Smart Routing**: 14-dimension complexity scoring → LIGHT/MEDIUM/HEAVY tier → automatic model selection
- 📦 **Context Compression**: Preemptive background summarization at configurable threshold (default 75%)
- 🔌 **All Providers**: Supports all OpenClaw providers via 6 API format adapters
- ⚡ **Zero Config Auth**: Uses OpenClaw's existing provider credentials — no separate API keys
- 📊 **Cost Tracking**: Real-time savings stats at /stats endpoint
- 🔄 **Hot Reload**: Config changes apply without restart

## Quick Start

Requires [Bun](https://bun.sh) and a working OpenClaw installation.

```bash
# Clone and install
git clone https://github.com/your-org/ClawMux
cd ClawMux
bash scripts/install.sh
```

The install script:
1. Detects your OpenClaw config at `~/.openclaw/openclaw.json` (override with `OPENCLAW_CONFIG_PATH`)
2. Creates `clawmux.json` from the example if it doesn't exist
3. Registers ClawMux as a provider in your OpenClaw config

Then start the proxy:

```bash
bun run dev        # watch mode (recommended during development)
bun run start      # production
```

Select a provider in OpenClaw and start chatting:

```bash
openclaw provider clawmux-anthropic
openclaw chat
```

## Configuration

Copy `clawmux.example.json` to `clawmux.json` and adjust as needed:

```jsonc
{
  "compression": {
    "threshold": 0.75,       // trigger compression at 75% of context window
    "model": "claude-3-5-haiku-20241022",  // model used for summarization
    "targetRatio": 0.6       // compress to 60% of original token count
  },
  "routing": {
    "models": {
      "LIGHT": "claude-3-5-haiku-20241022",
      "MEDIUM": "claude-sonnet-4-20250514",
      "HEAVY": "claude-opus-4-20250514"
      // Do NOT use model IDs containing "clawmux" — causes infinite loops
    },
    "scoring": {
      "boundaries": {
        "lightMedium": 0.0,
        "mediumHeavy": 0.35
      },
      "confidenceThreshold": 0.70  // fall back to HEAVY below this confidence
    }
  },
  "server": {
    "port": 3456,
    "host": "127.0.0.1"
  }
}
```

Config is watched for changes. Edit `clawmux.json` while the proxy is running and it reloads automatically.

## Supported Providers

ClawMux registers itself as six providers in OpenClaw, one per API format:

| API Format | Providers |
|---|---|
| `anthropic-messages` | Anthropic, Synthetic, Kimi Coding |
| `openai-completions` | OpenAI, Moonshot, ZAI, Cerebras, vLLM, SGLang, LM Studio, OpenRouter, Together, NVIDIA, Venice, Groq, Mistral, xAI, HuggingFace, Cloudflare, Volcengine, BytePlus, Vercel, Kilocode, Qianfan, ModelStudio, MiniMax, Xiaomi |
| `openai-responses` | OpenAI (newer), OpenAI Codex |
| `google-generative-ai` | Google Gemini, Google Vertex |
| `ollama` | Ollama |
| `bedrock-converse-stream` | AWS Bedrock |

Use `clawmux-anthropic`, `clawmux-openai`, `clawmux-openai-responses`, `clawmux-google`, `clawmux-ollama`, or `clawmux-bedrock` as the provider name in OpenClaw.

## How It Works

```
OpenClaw → ClawMux Proxy (localhost:3456) → Upstream Provider
              │
              ├── 1. Score complexity (14 dimensions, <1ms)
              ├── 2. Select tier → LIGHT/MEDIUM/HEAVY
              ├── 3. Compress context if threshold exceeded
              └── 4. Forward to upstream with correct model
```

**Routing tiers** map to model IDs you configure. The scorer evaluates message length, code presence, reasoning depth, multi-step instructions, and other signals to pick the cheapest model that can handle the request.

**Context compression** runs in the background after each response. When the conversation approaches the configured threshold, ClawMux summarizes older messages before the next request goes out. This keeps costs down on long conversations without interrupting the flow.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/stats` | Cost savings statistics |
| `POST` | `/v1/messages` | Anthropic Messages |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses |
| `POST` | `/v1beta/models/*` | Google Generative AI |
| `POST` | `/api/chat` | Ollama |
| `POST` | `/model/*/converse-stream` | Bedrock |

## Development

```bash
bun run dev          # start with watch mode
bun test             # run all tests
bun run typecheck    # type check without emit
```

Tests are co-located with source files as `*.test.ts`.

## Uninstall

```bash
bash scripts/uninstall.sh
```

Removes all `clawmux-*` providers from your OpenClaw config. Your original config is backed up before any changes.

## License

MIT
