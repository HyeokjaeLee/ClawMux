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
- `src/routing/` — signal-based escalation routing (SignalDetector, EscalationMemory, InstructionInjector, SignalRouter)
- `src/utils/` — token estimator and shared utilities

## OpenClaw Parity (pi-ai integration)
- ClawMux delegates upstream HTTP to `@mariozechner/pi-ai` so every request matches OpenClaw byte-for-byte.
- Entry routes covered by the pi-ai path: `anthropic-messages`, `openai-completions`, `openai-responses`, `google-generative-ai`. `ollama` and `bedrock-converse-stream` still use the legacy adapter fallback.
- Downstream responses are translated from pi-ai events back into the client's requested API format via `src/pi-bridge/event-to-*.ts`.
- OAuth-only providers (e.g., `openai-codex`) read tokens from the external CLI store (`~/.codex/auth.json`) via `src/pi-bridge/oauth-resolver.ts`.
- Set `CLAWMUX_PIAI=0` to bypass the pi-ai path (e.g., for legacy adapter tests).

## Signal-Based Escalation Routing
- All requests start at LIGHT tier. The LIGHT model receives an injected instruction to emit `===CLAWMUX_ESCALATE===` if it cannot handle the request.
- When the signal is detected in the model's output, the request is automatically retried at the next tier (LIGHT→MEDIUM→HEAVY, max 3 attempts).
- Escalation memory tracks sessions by fingerprint (first N messages) and sticks to the escalated tier with dual TTL: active (5 min idle) and max lifetime (2 hours).
- HEAVY tier never receives instruction injection or signal detection — it is the final tier.
- Kill switch: set `routing.escalation.enabled` to `false` in config to bypass signal routing and always use MEDIUM tier.
- Config: `src/routing/signal-router.ts`, `src/routing/signal-detector.ts`, `src/routing/escalation-memory.ts`, `src/routing/instruction-injector.ts`.
- Upstream retry: `fetchWithRetry()` in `src/proxy/pipeline.ts` retries 429/500/502/503 and network errors with exponential backoff (respects `Retry-After`, max 3 retries).
