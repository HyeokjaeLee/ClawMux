import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import type { ClawMuxConfig } from "../config/types.ts";
import type { OpenClawConfig, AuthProfile } from "../openclaw/types.ts";
import type { CompressionMiddleware } from "./compression-integration.ts";
import { handleApiRequest } from "./pipeline.ts";
import { SignalRouter } from "../routing/signal-router.ts";

let mockServer: ReturnType<typeof Bun.serve>;
let mockPort: number;
let upstreamCalled = false;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    fetch: async () => {
      upstreamCalled = true;
      return new Response(
        JSON.stringify({ id: "msg_test", content: [{ type: "text", text: "Hello!" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  mockPort = mockServer.port as number;
});

afterAll(() => {
  mockServer.stop(true);
});

function makeConfig(): ClawMuxConfig {
  return {
    compression: { threshold: 0.8, model: "anthropic/claude-3-5-haiku-20241022" },
    routing: {
      models: {
        LIGHT: "anthropic/claude-3-5-haiku-20241022",
        MEDIUM: "anthropic/claude-sonnet-4-20250514",
        HEAVY: "anthropic/claude-opus-4-20250514",
      },

    },
  };
}

function makeOpenClawConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        anthropic: {
          baseUrl: `http://localhost:${mockPort}`,
          api: "anthropic-messages",
          apiKey: "test-key",
          models: [
            { id: "claude-3-5-haiku-20241022" },
            { id: "claude-sonnet-4-20250514" },
            { id: "claude-opus-4-20250514" },
          ],
        },
      },
    },
  };
}

function makeAuthProfiles(): AuthProfile[] {
  return [{ provider: "anthropic", apiKey: "test-key" }];
}

function makeRequest(headers?: Record<string, string>): Request {
  return new Request(`http://localhost:${mockPort}/v1/messages`, {
    method: "POST",
    headers,
  });
}

const testRouter = new SignalRouter({
  escalation: { activeThresholdMs: 300_000, maxLifetimeMs: 7_200_000, fingerprintRootCount: 5 },
  enabled: true,
});

function createMockCompressionMiddleware(
  summaryData?: { summary: string; recentMessages: Array<{ role: string; content: unknown }> },
): CompressionMiddleware {
  return {
    beforeForward: (parsed) => ({ messages: parsed.messages, wasCompressed: false }),
    afterResponse: () => {},
    getSessionStore: () => {
      throw new Error("not implemented");
    },
    getWorker: () => {
      throw new Error("not implemented");
    },
    getSummaryForSession: () => summaryData,
  };
}

describe("compaction detection in pipeline", () => {
  it("returns synthetic response when compaction detected and summary available", async () => {
    upstreamCalled = false;

    const middleware = createMockCompressionMiddleware({
      summary: "User discussed sorting algorithms.",
      recentMessages: [
        { role: "user", content: "What about quicksort?" },
        { role: "assistant", content: "It uses divide and conquer." },
      ],
    });

    const body = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: "Response" },
        { role: "user", content: "summarize the conversation" },
      ],
      stream: false,
      max_tokens: 1024,
    };

    const response = await handleApiRequest(
      makeRequest({ "x-request-compaction": "true" }),
      body,
      "anthropic-messages",
      makeConfig(),
      makeOpenClawConfig(),
      makeAuthProfiles(),
      middleware,
      testRouter,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-synthetic-response")).toBe("true");
    expect(upstreamCalled).toBe(false);

    const json = await response.json() as Record<string, unknown>;
    const content = json.content as Array<Record<string, unknown>>;
    expect(content[0].text).toContain("<summary>");
    expect(content[0].text).toContain("User discussed sorting algorithms.");
  });

  it("forwards to upstream when compaction detected but no summary available", async () => {
    upstreamCalled = false;

    const middleware = createMockCompressionMiddleware(undefined);

    const body = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: "Response" },
        { role: "user", content: "compact the conversation" },
      ],
      stream: false,
      max_tokens: 1024,
    };

    const response = await handleApiRequest(
      makeRequest({ "x-request-compaction": "true" }),
      body,
      "anthropic-messages",
      makeConfig(),
      makeOpenClawConfig(),
      makeAuthProfiles(),
      middleware,
      testRouter,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-synthetic-response")).toBeNull();
    expect(upstreamCalled).toBe(true);
  });

  it("follows normal pipeline for non-compaction requests", async () => {
    upstreamCalled = false;

    const middleware = createMockCompressionMiddleware({
      summary: "Should not be used",
      recentMessages: [],
    });

    const body = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Write a hello world function" }],
      stream: false,
      max_tokens: 1024,
    };

    const response = await handleApiRequest(
      makeRequest(),
      body,
      "anthropic-messages",
      makeConfig(),
      makeOpenClawConfig(),
      makeAuthProfiles(),
      middleware,
      testRouter,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-synthetic-response")).toBeNull();
    expect(upstreamCalled).toBe(true);
  });

  it("detects compaction via prompt pattern without header", async () => {
    upstreamCalled = false;

    const middleware = createMockCompressionMiddleware({
      summary: "Pattern-detected summary.",
      recentMessages: [{ role: "user", content: "last msg" }],
    });

    const body = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "First message" },
        { role: "assistant", content: "Response" },
        { role: "user", content: "Your task is to create a detailed summary of the conversation so far." },
      ],
      stream: false,
      max_tokens: 1024,
    };

    const response = await handleApiRequest(
      makeRequest(),
      body,
      "anthropic-messages",
      makeConfig(),
      makeOpenClawConfig(),
      makeAuthProfiles(),
      middleware,
      testRouter,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-synthetic-response")).toBe("true");
    expect(upstreamCalled).toBe(false);
  });

  it("proceeds normally when no compression middleware provided", async () => {
    upstreamCalled = false;

    const body = {
      model: "claude-sonnet-4-20250514",
      messages: [
        { role: "user", content: "First message" },
        { role: "user", content: "summarize the conversation" },
      ],
      stream: false,
      max_tokens: 1024,
    };

    const response = await handleApiRequest(
      makeRequest({ "x-request-compaction": "true" }),
      body,
      "anthropic-messages",
      makeConfig(),
      makeOpenClawConfig(),
      makeAuthProfiles(),
      undefined,
      testRouter,
    );

    expect(response.status).toBe(200);
    expect(upstreamCalled).toBe(true);
  });
});
