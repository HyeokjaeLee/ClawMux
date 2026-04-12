# How It Works

## Request Flow

```
OpenClaw → ClawMux Proxy (localhost:3456) → Upstream Provider(s)
              │
              ├── 1. Classify complexity (local embedding, ~8ms)
              ├── 2. Select tier → LIGHT / MEDIUM / HEAVY
              ├── 3. Compress context if threshold exceeded
              ├── 4. Translate request format if cross-provider
              ├── 5. Forward to upstream with resolved model
              └── 6. Translate response back to original format
```

## Smart Routing

### Classification

Requests are classified using a local embedding model (`Xenova/multilingual-e5-small`, 384 dimensions). No external API calls are needed.

The classifier works by:
1. Computing centroid embeddings for each tier from training examples
2. Embedding the incoming user message
3. Finding the nearest centroid via cosine similarity
4. Returning the tier with a confidence score

Performance:
- Cold start: ~3s (model load + centroid computation, once)
- Classification: ~8ms p50
- Short text heuristic: <1ms (bypasses embedding for greetings, confirmations)

### Tiers

| Tier | Use Case | Examples |
|---|---|---|
| LIGHT | Simple queries | Greetings, yes/no, factual questions |
| MEDIUM | Moderate tasks | Code generation, explanations, single-file edits |
| HEAVY | Complex tasks | Architecture design, multi-domain analysis, debugging |

### Context-Aware Re-classification

When the user sends a short follow-up like "explain that again", the classifier detects it as a context-dependent query. It then re-embeds the message with conversation context to determine the actual complexity.

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
