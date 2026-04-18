process.env.CLAWMUX_PIAI = "0";
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "../proxy/server.ts";
import { setupPipelineRoutes } from "../proxy/pipeline.ts";
import { clearCustomHandlers, setRouteHandler } from "../proxy/router.ts";
import { createStatsTracker, createStatsHandler } from "../proxy/stats.ts";
import type { ClawMuxConfig } from "../config/types.ts";
import type { OpenClawConfig, AuthProfile } from "../openclaw/types.ts";

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

let lastUpstreamRequest: CapturedRequest | null = null;
let upstreamResponseStatus = 200;
let upstreamResponseBody = JSON.stringify({
  id: "msg_e2e_test",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "Hello from mock upstream" }],
  model: "claude-3-5-haiku-20241022",
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
});
let upstreamResponseHeaders: Record<string, string> = {
  "content-type": "application/json",
};


let mockUpstream: ReturnType<typeof Bun.serve>;
let mockUpstreamPort: number;

let proxyServer: ReturnType<typeof createServer>;
let proxyPort: number;

const statsTracker = createStatsTracker();

const COMPLEX_CONTENT = [
  "Implement a distributed consensus algorithm using Raft protocol. ",
  "Handle leader election, log replication, and safety guarantees. ",
  "Include error handling for network partitions and node failures. ",
  "Write comprehensive unit tests and integration tests. ",
  "Optimize for performance with batched log entries. ",
  "Analyze time complexity of each operation and explain ",
  "trade-offs between consistency and availability. ",
  "Refactor the codebase to use dependency injection patterns. ",
  "Debug the race condition in the concurrent access module. ",
  "Architect a microservices solution with proper API gateway integration.",
].join("");

function makeClawMuxConfig(): ClawMuxConfig {
  return {
    compression: {
      threshold: 0.75,
      model: "anthropic/claude-3-5-haiku-20241022",
      targetRatio: 0.6,
    },
    routing: {
      models: {
        LIGHT: "anthropic/claude-3-5-haiku-20241022",
        MEDIUM: "anthropic/claude-sonnet-4-20250514",
        HEAVY: "anthropic/claude-opus-4-20250514",
      },

    },
    server: { port: 0, host: "127.0.0.1" },
  };
}

function makeOpenClawConfig(baseUrl: string): OpenClawConfig {
  return {
    models: {
      providers: {
        anthropic: {
          baseUrl,
          api: "anthropic-messages",
          apiKey: "test-key-anthropic",
          models: [
            { id: "claude-3-5-haiku-20241022" },
            { id: "claude-sonnet-4-20250514" },
            { id: "claude-opus-4-20250514" },
          ],
        },
        openai: {
          baseUrl,
          api: "openai-completions",
          apiKey: "test-key-openai",
          models: [
            { id: "gpt-4o-mini" },
            { id: "gpt-4o" },
          ],
        },
      },
    },
  };
}

function makeAuthProfiles(): AuthProfile[] {
  return [
    { provider: "anthropic", apiKey: "test-key-anthropic" },
    { provider: "openai", apiKey: "test-key-openai" },
  ];
}

beforeAll(() => {
  mockUpstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const headers: Record<string, string> = {};
      for (const [k, v] of req.headers.entries()) {
        headers[k] = v;
      }

      let body: Record<string, unknown> | null = null;
      const text = await req.text();
      if (text) {
        body = JSON.parse(text) as Record<string, unknown>;
      }

      lastUpstreamRequest = { method: req.method, path, headers, body };

      return new Response(upstreamResponseBody, {
        status: upstreamResponseStatus,
        headers: upstreamResponseHeaders,
      });
    },
  });
  mockUpstreamPort = mockUpstream.port as number;

  // Port 0 trick: allocate a free port via a temporary server, then reuse it.
  // Bun.serve does not expose a port-0 option on createServer, so we probe one here.
  const tempServer = Bun.serve({ port: 0, fetch: () => new Response("") });
  proxyPort = tempServer.port as number;
  tempServer.stop(true);

  const config = makeClawMuxConfig();
  const openclawConfig = makeOpenClawConfig(`http://127.0.0.1:${mockUpstreamPort}`);
  const authProfiles = makeAuthProfiles();

  setRouteHandler("/stats", createStatsHandler(statsTracker));
  setupPipelineRoutes(config, openclawConfig, authProfiles, undefined);

  proxyServer = createServer({ port: proxyPort, host: "127.0.0.1" });
  proxyServer.start();
});

afterAll(() => {
  proxyServer.stop();
  mockUpstream.stop(true);
  clearCustomHandlers();
});

function proxyUrl(path: string): string {
  return `http://127.0.0.1:${proxyPort}${path}`;
}

function resetUpstream(
  status = 200,
  body = upstreamResponseBody,
  headers: Record<string, string> = { "content-type": "application/json" },
): void {
  upstreamResponseStatus = status;
  upstreamResponseBody = body;
  upstreamResponseHeaders = headers;
  lastUpstreamRequest = null;
}

describe("GET /health", () => {
  test("returns 200 with status ok", async () => {
    const res = await fetch(proxyUrl("/health"));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
  });
});

describe("GET /stats", () => {
  test("returns valid JSON with byTier counts", async () => {
    const res = await fetch(proxyUrl("/stats"));
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.totalRequests).toBe("number");

    const byTier = body.byTier as Record<string, unknown>;
    expect(typeof byTier.LIGHT).toBe("number");
    expect(typeof byTier.MEDIUM).toBe("number");
    expect(typeof byTier.HEAVY).toBe("number");

    expect(typeof body.savings).toBe("string");
    expect(typeof body.startedAt).toBe("string");
  });
});

describe("Anthropic routing", () => {
  test("simple message routes to LIGHT tier — model changed in upstream request", async () => {
    resetUpstream();

    const res = await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
      }),
    });

    expect(res.status).toBe(200);
    expect(lastUpstreamRequest).not.toBeNull();

    const sentModel = lastUpstreamRequest!.body?.model as string;
    expect(typeof sentModel).toBe("string");
    expect(sentModel).not.toBe("claude-opus-4-20250514");
    expect(lastUpstreamRequest!.headers["x-api-key"]).toBe("test-key-anthropic");
  });

  test("complex message routes to HEAVY tier", async () => {
    resetUpstream();

    const res = await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-3-5-haiku-20241022",
        messages: [{ role: "user", content: COMPLEX_CONTENT }],
        max_tokens: 8192,
      }),
    });

    expect(res.status).toBe(200);
    expect(lastUpstreamRequest).not.toBeNull();

    const sentModel = lastUpstreamRequest!.body?.model as string;
    expect(sentModel).toBe("claude-opus-4-20250514");
  });

  test("upstream response is passed through transparently", async () => {
    const customBody = JSON.stringify({
      id: "msg_custom",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Custom response" }],
      model: "claude-3-5-haiku-20241022",
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    resetUpstream(200, customBody);

    const res = await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 256,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.id).toBe("msg_custom");
    expect((body.content as Array<{ text: string }>)[0].text).toBe("Custom response");
  });

  test("upstream 429 is forwarded as-is", async () => {
    resetUpstream(429, JSON.stringify({
      error: { type: "rate_limit_error", message: "Too many requests" },
    }));

    const res = await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 256,
      }),
    });

    expect(res.status).toBe(429);
    const body = await res.json() as Record<string, unknown>;
    const err = body.error as Record<string, unknown>;
    expect(err.type).toBe("rate_limit_error");

    resetUpstream();
  });
});

describe("OpenAI routing", () => {
  test("simple message routes to LIGHT tier — model changed in upstream request", async () => {
    resetUpstream(200, JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hi!" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }));

    const res = await fetch(proxyUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
      }),
    });

    expect(res.status).toBe(200);
    expect(lastUpstreamRequest).not.toBeNull();

    const sentModel = lastUpstreamRequest!.body?.model as string;
    expect(typeof sentModel).toBe("string");
    expect(sentModel).not.toBe("gpt-4o");

    const hasAuth =
      lastUpstreamRequest!.headers["authorization"]?.includes("Bearer") ||
      typeof lastUpstreamRequest!.headers["x-api-key"] === "string";
    expect(hasAuth).toBe(true);
  });

  test("complex message routes to HEAVY tier", async () => {
    resetUpstream(200, JSON.stringify({
      id: "chatcmpl-complex",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Complex answer" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
    }));

    const res = await fetch(proxyUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: COMPLEX_CONTENT }],
        max_tokens: 8192,
      }),
    });

    expect(res.status).toBe(200);
    expect(lastUpstreamRequest).not.toBeNull();

    const sentModel = lastUpstreamRequest!.body?.model as string;
    expect(sentModel).toBe("claude-opus-4-20250514");
  });
});

describe("Stats tier distribution", () => {
  test("/stats reflects recorded tier counts via tracker", async () => {
    statsTracker.reset();

    statsTracker.recordRequest("LIGHT", "claude-3-5-haiku-20241022", 100, 0.000025);
    statsTracker.recordRequest("HEAVY", "claude-opus-4-20250514", 500, 0.0075);
    statsTracker.recordRequest("LIGHT", "claude-3-5-haiku-20241022", 80, 0.00002);

    const res = await fetch(proxyUrl("/stats"));
    expect(res.status).toBe(200);

    const body = await res.json() as { byTier: { LIGHT: number; MEDIUM: number; HEAVY: number }; totalRequests: number; savings: string };
    expect(body.totalRequests).toBe(3);
    expect(body.byTier.LIGHT).toBe(2);
    expect(body.byTier.MEDIUM).toBe(0);
    expect(body.byTier.HEAVY).toBe(1);
    expect(typeof body.savings).toBe("string");
  });
});

describe("Error handling", () => {
  test("malformed JSON body returns 400", async () => {
    const res = await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });

  test("unknown route returns 404", async () => {
    const res = await fetch(proxyUrl("/v1/unknown-endpoint"));
    expect(res.status).toBe(404);
  });
});
