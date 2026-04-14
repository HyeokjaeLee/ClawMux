# Configuration

Follow these steps to complete model configuration.

### Step 1: Discover Available Models

Read the user's OpenClaw config to find which providers and models they have:

```bash
cat ~/.openclaw/openclaw.json
```

Look at `models.providers` — each key is a provider name, and each provider has a `models` array with available model IDs.

### Step 2: Ask the User About Model Assignment

Ask the user which models to use for each tier. Explain the tiers:

| Tier | Purpose | Ideal Model |
|---|---|---|
| **LIGHT** | Greetings, yes/no, simple factual questions | Cheapest/fastest (e.g., Haiku, GPT-4o-mini, GLM Flash) |
| **MEDIUM** | Coding tasks, explanations, single-file edits | Balanced (e.g., Sonnet, GPT-4o) |
| **HEAVY** | Architecture design, multi-domain analysis, debugging | Most capable (e.g., Opus, GPT-5.4) |
| **compression.model** | Background summarization of long conversations | Same as LIGHT (fast and cheap) |

If the user doesn't have a preference, recommend models based on their available providers.

### Step 3: Write the Config

Edit `~/.openclaw/clawmux.json` with the user's choices. Model IDs use `provider/model` format matching the keys in `openclaw.json`.

⚠️ **Do NOT use `clawmux` as a provider name in model IDs** — this causes infinite routing loops.

Example for Anthropic-only:

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

Example for cross-provider:

```json
{
  "compression": {
    "threshold": 0.75,
    "model": "zai/glm-5"
  },
  "routing": {
    "models": {
      "LIGHT": "zai/glm-5",
      "MEDIUM": "anthropic/claude-sonnet-4-20250514",
      "HEAVY": "openai/gpt-5.4"
    }
  }
}
```

### Step 4: Sync OpenClaw Provider Format

After writing `clawmux.json`, run `clawmux init` again to update the OpenClaw provider registration:

```bash
clawmux init
```

This re-reads the MEDIUM model from `~/.openclaw/clawmux.json`, looks up its provider's API format in `openclaw.json`, and updates the `clawmux` provider's `api` field accordingly. This ensures OpenClaw sends requests in the correct format for the MEDIUM tier — minimizing unnecessary format translation.

**Always re-run `clawmux init` whenever you change the MEDIUM model in `~/.openclaw/clawmux.json`.**

### Step 5: Verify

```bash
curl -s http://localhost:3456/health
curl -s http://localhost:3456/stats
```

If both return JSON, configuration is complete. Tell the user:

```bash
openclaw provider clawmux
openclaw chat
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

Model IDs use `provider/model` format matching your OpenClaw config. Do **not** use `clawmux` as a provider name here — this causes infinite routing loops.

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

1. `~/.openclaw/clawmux.json` → `routing.contextWindows` (explicit override)
2. `openclaw.json` → provider model config
3. OpenClaw built-in catalog (833+ models)
4. Default: 200,000 tokens

Compression uses the **minimum** context window across all routing models.

## Hot Reload

Edit `~/.openclaw/clawmux.json` while the proxy is running. Changes are detected via filesystem watcher and applied automatically with a 2-second debounce. Invalid config changes are ignored with a warning.
