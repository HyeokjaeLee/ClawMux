![ClawMux logo](./docs/images/clawmux.png)
# ClawMux

Smart model routing + context compression proxy for OpenClaw.

## Features

- 🧠 **Smart Routing**: Signal-based escalation → LIGHT tries first, auto-escalates to MEDIUM/HEAVY when needed
- 📦 **Context Compression**: Preemptive background summarization at configurable threshold (default 75%)
- 🔌 **All Providers**: Supports all OpenClaw providers via 6 API format adapters
- ⚡ **Zero Config Auth**: Uses OpenClaw's existing provider credentials — no separate API keys
- 📊 **Cost Tracking**: Real-time savings stats at /stats endpoint
- 🔄 **Hot Reload**: Config changes apply without restart

## Installation

Copy and paste this into your OpenClaw agent:

```bash
Install and configure ClawMux by following the instructions here:
curl -s https://raw.githubusercontent.com/HyeokjaeLee/ClawMux/refs/heads/main/docs/guide/installation.md
```

## Configuration

ClawMux stores its config at `~/.openclaw/clawmux.json` (next to `openclaw.json`). `clawmux init` creates it automatically. You can also copy `clawmux.example.json` as a starting point:

```bash
cp clawmux.example.json ~/.openclaw/clawmux.json
```

Adjust as needed:

```jsonc
{
  "compression": {
    "threshold": 0.75,       // trigger compression at 75% of context window
    "model": "anthropic/claude-3-5-haiku-20241022",  // model used for summarization (provider/model format)
    "targetRatio": 0.6       // compress to 60% of original token count
  },
  "routing": {
    "models": {
      "LIGHT": "anthropic/claude-3-5-haiku-20241022",
      "MEDIUM": "anthropic/claude-sonnet-4-20250514",
      "HEAVY": "anthropic/claude-opus-4-20250514"
      // Model IDs use 'provider/model' format. Do NOT use "clawmux" as provider — causes infinite loops
    }
  },
  "server": {
    "port": 3456,
    "host": "127.0.0.1"
  }
}
```

Config is watched for changes. Edit `~/.openclaw/clawmux.json` while the proxy is running and it reloads automatically. Override the path with `CLAWMUX_CONFIG=/path/to/clawmux.json`.

### Cross-Provider Routing

Mix models from different providers by tier. ClawMux automatically translates request and response formats between providers:

```jsonc
{
  "routing": {
    "models": {
      "LIGHT": "zai/glm-5",                          // ZAI (openai-completions)
      "MEDIUM": "anthropic/claude-sonnet-4-20250514",  // Anthropic (anthropic-messages)
      "HEAVY": "openai/gpt-5.4"                       // OpenAI (openai-completions)
    }
  }
}
```

All three providers must be configured in your `openclaw.json`. ClawMux handles format translation transparently — a request arriving in Anthropic format gets translated to OpenAI format when routed to GPT, and the response is translated back to Anthropic format before returning to OpenClaw.

Supported translation pairs: Anthropic ↔ OpenAI ↔ Google ↔ Ollama ↔ Bedrock (all combinations).

## Provider

ClawMux registers as a single provider `clawmux` in OpenClaw with model `auto`. It accepts all API formats (Anthropic, OpenAI, Google, Ollama, Bedrock) and translates between them automatically.

```bash
openclaw provider clawmux
```

## How It Works

```
OpenClaw → ClawMux Proxy (localhost:3456) → Upstream Provider(s)
              │
              ├── 1. Start at LIGHT tier (or escalated tier from memory)
              ├── 2. Inject escalation instruction if LIGHT/MEDIUM
              ├── 3. Compress context if threshold exceeded
              ├── 4. Forward to upstream with correct model
              ├── 5. Detect escalation signal in response
              ├── 6. If signal found → retry at next tier (max 3 attempts)
              └── 7. Translate response back to original format
```

**Signal-based escalation** routes all requests to the LIGHT model first. If the LIGHT model cannot handle the request, it emits `===CLAWMUX_ESCALATE===` and ClawMux automatically retries at the next tier (LIGHT→MEDIUM→HEAVY). Sessions that previously escalated are remembered for up to 2 hours (5 min idle timeout), so follow-up requests go directly to the appropriate tier.

**Kill switch**: Set `routing.escalation.enabled` to `false` in your config to disable escalation and always use the MEDIUM model. This is useful for debugging or when you want predictable routing.

**Context compression** runs in the background after each response. When the conversation approaches the configured threshold, ClawMux summarizes older messages before the next request goes out. This keeps costs down on long conversations without interrupting the flow.

### Context Window Resolution

ClawMux resolves each model's context window using this priority chain:

1. **~/.openclaw/clawmux.json** `routing.contextWindows` — explicit per-model override
2. **openclaw.json** `models.providers[provider].models[].contextWindow` — user config
3. **OpenClaw built-in catalog** — pi-ai model database (812+ models)
4. **Default: 200,000 tokens**

Compression threshold uses the **minimum** context window across all routing models, since compression happens before routing decides which model to use.

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

Copy and paste this into your OpenClaw agent:

```bash
Uninstall ClawMux by following the instructions here:
curl -s https://raw.githubusercontent.com/HyeokjaeLee/ClawMux/refs/heads/main/docs/guide/uninstallation.md
```
