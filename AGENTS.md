# ClawMux Development Guide

## Runtime
- Dual runtime: Bun (recommended) and Node.js 18+ supported
- Production code must NOT use Bun-specific APIs directly — use `src/utils/runtime.ts` abstraction
- Tests use `bun:test` (Bun-only)

## Conventions
- File naming: kebab-case (e.g., token-estimator.ts)
- Variables: camelCase, Types: PascalCase
- No `as any`, `@ts-ignore`, `@ts-expect-error`
- No empty catch blocks
- No external HTTP frameworks (Express, Hono, Fastify)
- No external validation libraries (Zod, Joi)
- Use `import type` for type-only imports

## Testing
- Framework: `bun test` (built-in)
- Test files: co-located as `*.test.ts`
- E2E tests: `src/e2e/` directory, use real `Bun.serve()` with mock upstreams

## Build
- `bun run typecheck` — type check without emit
- `bun test` — run all tests
- `bun run dev` — development with watch mode
- `bun run start` — production start (no watch)
- `npm run start:node` — Node.js production start (requires tsx)

## Project Structure
- `src/adapters/` — API format adapters (anthropic, openai-completions, etc.)
- `src/compression/` — context compression logic and session store
- `src/config/` — config loading, validation, hot-reload watcher
- `src/openclaw/` — OpenClaw config parsing and auth resolution
- `src/pi-bridge/` — pi-ai integration: builds Context/Options from ParsedRequest, OAuth token resolution, and per-format event→response translators
- `src/proxy/` — HTTP server, router, pipeline, stats
- `src/routing/` — complexity scorer and tier mapper
- `src/utils/` — token estimator and shared utilities

## OpenClaw Parity (pi-ai integration)
- ClawMux delegates upstream HTTP to `@mariozechner/pi-ai` so every request matches OpenClaw byte-for-byte.
- Entry routes covered by the pi-ai path: `anthropic-messages`, `openai-completions`, `openai-responses`, `google-generative-ai`. `ollama` and `bedrock-converse-stream` still use the legacy adapter fallback.
- Downstream responses are translated from pi-ai events back into the client's requested API format via `src/pi-bridge/event-to-*.ts`.
- OAuth-only providers (e.g., `openai-codex`) read tokens from the external CLI store (`~/.codex/auth.json`) via `src/pi-bridge/oauth-resolver.ts`.
- Set `CLAWMUX_PIAI=0` to bypass the pi-ai path (e.g., for legacy adapter tests).

## Routing Classifier
- Embedding model: `Xenova/multilingual-e5-small` (multilingual sentence embeddings for tier classification).
- Default dtype: `fp16` (good accuracy, ~860MB RSS working set, ~67ms avg per classification on CPU).
- Override via `CLAWMUX_EMBEDDING_DTYPE` env var (`fp32`, `fp16`, `q8`, `q4`).
- `q8` benchmarked on 154 real production prompts: 86.36% tier agreement with fp16, ~2x faster, saves ~244MB RSS. NOT recommended for production — tier drift can push cron/exec prompts into HEAVY (gpt-5.4), risking upstream quota exhaustion. Use only if memory is critically constrained.
- Upstream retry: `fetchWithRetry()` in `src/proxy/pipeline.ts` retries 429/500/502/503 and network errors with exponential backoff (respects `Retry-After`, max 3 retries).
