# Configuration

ClawMux is configured via `clawmux.json` in the project root. Changes are watched and applied without restart.

## Minimal Config

```json
{
  "compression": {
    "threshold": 0.75,
    "model": "anthropic/claude-3-5-haiku-20241022"
  },
  "routing": {
    "models": {
      "LIGHT": "anthropic/claude-3-5-haiku-20241022",
      "MEDIUM": "anthropic/claude-sonnet-4-20250514",
      "HEAVY": "anthropic/claude-opus-4-20250514"
    }
  }
}
```

## Full Config Reference

### compression

| Field | Type | Default | Description |
|---|---|---|---|
| `threshold` | number | `0.75` | Trigger compression at this fraction of context window (0.1–0.95) |
| `model` | string | required | Model used for summarization (`provider/model` format) |
| `targetRatio` | number | `0.6` | Compress to this fraction of original token count (0.2–0.9) |

### routing

#### routing.models

| Field | Type | Description |
|---|---|---|
| `LIGHT` | string | Model for simple queries (greetings, short questions) |
| `MEDIUM` | string | Model for moderate tasks (coding, explanations) |
| `HEAVY` | string | Model for complex tasks (architecture, multi-domain analysis) |

Model IDs use `provider/model` format matching your OpenClaw config. Do **not** use `clawmux-*` provider names here — this causes infinite routing loops.

#### routing.contextWindows (optional)

Per-model context window overrides in tokens:

```json
{
  "routing": {
    "contextWindows": {
      "zai/glm-5": 204800,
      "openai/gpt-5.4": 400000
    }
  }
}
```

### server (optional)

| Field | Type | Default | Description |
|---|---|---|---|
| `port` | number | `3456` | Proxy server port (1024–65535) |
| `host` | string | `"127.0.0.1"` | Bind address |

## Cross-Provider Routing

Mix models from different providers. ClawMux translates formats automatically:

```json
{
  "routing": {
    "models": {
      "LIGHT": "zai/glm-5",
      "MEDIUM": "anthropic/claude-sonnet-4-20250514",
      "HEAVY": "openai/gpt-5.4"
    }
  }
}
```

All providers must be configured in your `openclaw.json`. Supported translation pairs: Anthropic, OpenAI, Google, Ollama, Bedrock (all combinations).

## Context Window Resolution

ClawMux resolves each model's context window in this order:

1. `clawmux.json` → `routing.contextWindows` (explicit override)
2. `openclaw.json` → provider model config
3. OpenClaw built-in catalog (833+ models)
4. Default: 200,000 tokens

Compression uses the **minimum** context window across all routing models.

## Hot Reload

Edit `clawmux.json` while the proxy is running. Changes are detected via filesystem watcher and applied automatically with a 2-second debounce. Invalid config changes are ignored with a warning.
