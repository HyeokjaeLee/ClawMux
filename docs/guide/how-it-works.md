# How It Works

## Request Flow

```
OpenClaw → ClawMux Proxy (localhost:3456) → Upstream Provider(s)
              │
              ├── 1. Select initial tier — LIGHT, or the remembered tier
              │      if escalation memory holds a record for this session
              ├── 2. Inject escalation instruction if the tier is LIGHT or MEDIUM
              ├── 3. Compress context if threshold exceeded
              ├── 4. Translate request format if cross-provider
              ├── 5. Forward to upstream with the tier's model
              ├── 6. Scan the streaming response for the escalation signal
              │      — if detected, retry at the next tier (max 3 attempts)
              └── 7. Translate the final response back to the original format
```

## Signal-Based Escalation Routing

### Tiers

| Tier | Role | Escalation Instruction | Next Tier |
|---|---|---|---|
| LIGHT | First attempt for every new session | Injected | MEDIUM |
| MEDIUM | Second attempt when LIGHT signals escalation | Injected | HEAVY |
| HEAVY | Terminal tier — handles anything | Not injected | — |

The escalation instruction tells the model to emit the literal marker `===CLAWMUX_ESCALATE===` on its own line, with no other text, if it cannot handle the request due to complexity, missing context, or capability limits. HEAVY is the terminal tier, so injecting the instruction there would only pollute its prompt.

### Escalation Flow

1. **Select the starting tier.** For a fresh session fingerprint, start at LIGHT. If escalation memory remembers a higher tier for this session, start there instead and skip the earlier tiers.
2. **Inject the escalation instruction** into the system prompt for LIGHT or MEDIUM. HEAVY requests are forwarded unchanged.
3. **Stream the upstream response** through a signal detector that scans every `text_delta` chunk for the escalation marker.
4. **If the signal fires**, discard the in-progress response, move to the next tier, and retry. Up to 3 attempts total per request (LIGHT → MEDIUM → HEAVY).
5. **If the response completes cleanly**, translate it back to the client's requested format and record a successful escalation in memory (only when the accepted tier is MEDIUM or HEAVY).

### Escalation Memory

Sessions are fingerprinted by hashing the first N messages of the conversation (default N = 5, configurable via `routing.escalation.fingerprintRootCount`). The memory maps each fingerprint to the highest tier the session has successfully escalated to, with a dual time-to-live:

| TTL | Default | Meaning |
|---|---|---|
| Active | 5 minutes | Time since the last request touched the record. Reset on each new request (`touchActivity`). |
| Max lifetime | 2 hours | Hard cap from the initial escalation. Prevents infinitely sticky records for long-lived sessions. |

Follow-up messages in the same session skip LIGHT and MEDIUM attempts when the fingerprint matches a remembered HEAVY (or MEDIUM) tier, so the user doesn't pay the escalation cost on every turn.

### Kill Switch

Set `routing.escalation.enabled` to `false` in `~/.openclaw/clawmux.json` to bypass signal-based routing entirely. Every request is served directly by the MEDIUM model — no injection, no signal detection, no memory lookup. Useful for debugging or predictable routing.

### Upstream Retry

Independent of the escalation loop, each upstream call is wrapped in `fetchWithRetry()` (see `src/proxy/pipeline.ts`). It retries on:

- HTTP 429, 500, 502, 503
- Network errors (DNS, TCP reset, timeouts)

Retries use exponential backoff, respect `Retry-After` headers, and are capped at 3 attempts per call. A tier-escalation retry is a separate concept from an upstream-error retry — both can happen in the same request.

## Context Compression

### Trigger

Compression activates when conversation tokens exceed `threshold × contextWindow` (default 75%).

### Flow

```
75% ── Background compression triggered
         │  LLM summarizes conversation into structured template
         │  (Goal / Progress / Decisions / Next Steps)
         │
         ▼  Next request: [summary] + [all messages since trigger] replaces full history
```

### Safety Mechanisms

**Snapshot tracking**: When compression triggers, the current message index is recorded. On application, all messages added after that point are preserved — no messages are lost between trigger and application.

**Hard ceiling**: If tokens reach 90% before background compression finishes, messages are truncated immediately (keeping recent messages) to prevent upstream API errors.

**Compaction interception**: When OpenClaw sends its own summarization request (detected via header or prompt pattern), ClawMux returns a pre-computed summary instantly without calling upstream — saving an API call.

### Compression Prompt

The summarizer uses a structured template:

```
## Goal
## Constraints & Preferences
## Progress (Done / In Progress / Blocked)
## Key Decisions
## Active State (file paths, URLs)
## Next Steps
## Critical Context
```

## Cross-Provider Translation

ClawMux supports 6 API formats and translates between all combinations:

| Format | Direction |
|---|---|
| Anthropic Messages | Request ↔ Response |
| OpenAI Chat Completions | Request ↔ Response |
| OpenAI Responses | Request ↔ Response |
| Google Generative AI | Request ↔ Response |
| Ollama | Request ↔ Response |
| AWS Bedrock | Request ↔ Response |

A request arriving in Anthropic format routed to an OpenAI model gets translated before forwarding. The response is translated back to Anthropic format before returning to OpenClaw.

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
