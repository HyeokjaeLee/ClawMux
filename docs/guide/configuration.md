# Configuration

Follow these steps to complete model configuration.

### Step 1: Discover Authenticated Providers and Models

Read the user's OpenClaw config and identify which providers have valid authentication:

```bash
cat ~/.openclaw/openclaw.json
```

Look at `models.providers`. For each provider, check authentication fields:
- `apiKey` field is present and non-empty
- `auth` field is set (e.g., `"oauth"`, `"token"`)

Also check agent-level overrides which may contain apiKey values that override the global config:

```bash
for f in ~/.openclaw/agents/*/agent/models.json; do echo "=== $f ==="; cat "$f"; done 2>/dev/null
```

**Only providers with confirmed authentication can be used as routing targets.**

List the authenticated providers and their available model IDs. For any provider without auth, note it as unavailable and do NOT suggest its models.

If no providers are authenticated, tell the user:
> No authenticated providers found in your OpenClaw config. Please configure at least one provider with an API key before setting up ClawMux routing.

### Step 2: Ask the User About Model Assignment

Ask the user which models to use for each tier. ClawMux tries LIGHT first and auto-escalates to MEDIUM and HEAVY only when the model itself signals it cannot handle the request. Explain the tiers:

| Tier | Role | Ideal Model |
|---|---|---|
| **LIGHT** | First attempt for every new session. Should handle most everyday requests and cleanly escalate when a request is beyond its capability. | Cheapest/fastest (e.g., Haiku, GPT-4o-mini, GLM Flash) |
| **MEDIUM** | Runs only when LIGHT escalates. Handles typical coding, explanations, and single-file edits. | Balanced (e.g., Sonnet, GPT-4o) |
| **HEAVY** | Terminal tier — runs only when MEDIUM also escalates. Used for architecture design, multi-domain analysis, or deep debugging. | Most capable (e.g., Opus, GPT-5.4) |
| **compression.model** | Background summarization of long conversations | Same as LIGHT (fast and cheap) |

Escalation is signal-based, not heuristic: LIGHT and MEDIUM receive an injected instruction that lets them emit `===CLAWMUX_ESCALATE===` when they want to hand off. HEAVY never receives the instruction, so its prompt stays clean.

If the user doesn't have a preference, recommend models based on their **authenticated** providers only.

**Before writing the config, verify each chosen model belongs to an authenticated provider.** If the user selects a model from a provider without authentication, warn them:
> ⚠️ `{provider}/{model}` cannot be used — `{provider}` has no API key or auth configured in your OpenClaw config. Please choose a model from an authenticated provider, or add credentials for `{provider}` in OpenClaw first.

### Step 3: Write the Config

Edit `~/.openclaw/clawmux.json` with the user's choices. Model IDs use `provider/model` format matching the keys in `openclaw.json`.

⚠️ **Do NOT use `clawmux` as a provider name in model IDs** — this causes infinite routing loops.

⚠️ **Only use models from providers confirmed to be authenticated in Step 1.** Using an unauthenticated provider will cause 401 errors at runtime.

Example (use only as format reference — replace with the user's actual authenticated models):

```json
{
  "compression": {
    "threshold": 0.75,
    "model": "{authenticated-provider}/{fast-model}"
  },
  "routing": {
    "models": {
      "LIGHT": "{authenticated-provider}/{fast-model}",
      "MEDIUM": "{authenticated-provider}/{balanced-model}",
      "HEAVY": "{authenticated-provider}/{powerful-model}"
    }
  }
}
```

After writing, confirm each model ID exactly matches a model listed under its provider in `openclaw.json`. If a model ID doesn't exist in the provider's `models` array, it will fail at runtime.

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
```

Then send a real test request to confirm routing and authentication work end-to-end:

```bash
curl -s -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer test" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

Expected: a valid response from the LIGHT model. If you see a 401 error, the LIGHT model's provider is not authenticated — go back to Step 1 and verify auth. If you see a 502 error, the upstream provider is unreachable.

If the test passes, tell the user:

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

#### routing.escalation (optional)

Controls signal-based escalation behavior.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | When `false`, bypass signal routing entirely and always use the MEDIUM model. No injection, no detection, no memory lookup. |
| `activeThresholdMs` | number | `300000` (5 min) | Evict a session's remembered tier if no request touches it for this long. |
| `maxLifetimeMs` | number | `7200000` (2 h) | Hard cap on how long a remembered tier survives from the initial escalation, regardless of activity. |
| `fingerprintRootCount` | number | `5` | Number of leading messages used to fingerprint a session for memory lookup. |

```json
{
  "routing": {
    "escalation": {
      "enabled": true,
      "activeThresholdMs": 300000,
      "maxLifetimeMs": 7200000,
      "fingerprintRootCount": 5
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

Mix models from different providers. ClawMux translates formats automatically.

All providers used must be configured **with valid authentication** in your `openclaw.json`. Supported translation pairs: Anthropic, OpenAI, Google, Ollama, Bedrock (all combinations).

## Context Window Resolution

ClawMux resolves each model's context window in this order:

1. `~/.openclaw/clawmux.json` → `routing.contextWindows` (explicit override)
2. `openclaw.json` → provider model config
3. OpenClaw built-in catalog (830+ models)
4. Default: 200,000 tokens

Compression uses the **minimum** context window across all routing models.

## Hot Reload

Edit `~/.openclaw/clawmux.json` while the proxy is running. Changes are detected via filesystem watcher and applied automatically with a 2-second debounce. Invalid config changes are ignored with a warning.
