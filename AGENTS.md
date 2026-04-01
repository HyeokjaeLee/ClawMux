# ClawMux Development Guide

## Runtime
- Bun (NOT Node.js) — use `bun run`, `bun test`, `Bun.serve()`

## Conventions
- Zero external dependencies
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

## Project Structure
- `src/adapters/` — API format adapters (anthropic, openai-completions, etc.)
- `src/compression/` — context compression logic and session store
- `src/config/` — config loading, validation, hot-reload watcher
- `src/openclaw/` — OpenClaw config parsing and auth resolution
- `src/proxy/` — HTTP server, router, pipeline, stats
- `src/routing/` — complexity scorer and tier mapper
- `src/utils/` — token estimator and shared utilities
