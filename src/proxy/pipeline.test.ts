import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import type { ClawMuxConfig } from "../config/types.ts";
import type { OpenClawConfig, AuthProfile } from "../openclaw/types.ts";
import { handleApiRequest } from "./pipeline.ts";

let mockServer: ReturnType<typeof Bun.serve>;
let mockPort: number;
let lastReceivedBody: Record<string, unknown> | null = null;
let lastReceivedHeaders: Record<string, string> = {};
let mockResponseBody = '{"id":"msg_test","content":[{"type":"text","text":"Hello!"}]}';
let mockResponseStatus = 200;
let mockResponseHeaders: Record<string, string> = { "content-type": "application/json" };
let mockSseMode = false;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const text = await req.text();
      let parsedBody: Record<string, unknown> | null = null;
      if (text) {
        parsedBody = JSON.parse(text);
      }

      lastReceivedHeaders = {};
      for (const [key, value] of req.headers.entries()) {
        lastReceivedHeaders[key] = value;
      }
      lastReceivedBody = parsedBody;

      if (mockSseMode) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: message_start\ndata: {\"type\":\"message_start\"}\n\n"));
            controller.enqueue(new TextEncoder().encode("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"Hi\"}}\n\n"));
            controller.enqueue(new TextEncoder().encode("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      return new Response(mockResponseBody, {
        status: mockResponseStatus,
        headers: mockResponseHeaders,
      });
    },
  });
  mockPort = mockServer.port as number;
});

afterAll(() => {
  mockServer.stop(true);
});

function makeConfig(overrides?: Partial<ClawMuxConfig["routing"]>): ClawMuxConfig {
  return {
    compression: { threshold: 0.8, model: "anthropic/claude-3-5-haiku-20241022" },
    routing: {
      models: {
        LIGHT: "anthropic/claude-3-5-haiku-20241022",
        MEDIUM: "anthropic/claude-sonnet-4-20250514",
        HEAVY: "anthropic/claude-opus-4-20250514",
      },
      ...overrides,
    },
  };
}

function makeOpenClawConfig(baseUrl: string): OpenClawConfig {
  return {
    models: {
      providers: {
        anthropic: {
          baseUrl,
          api: "anthropic-messages",
          apiKey: "test-anthropic-key",
          models: [
            { id: "claude-3-5-haiku-20241022" },
            { id: "claude-sonnet-4-20250514" },
            { id: "claude-opus-4-20250514" },
          ],
        },
        openai: {
          baseUrl,
          api: "openai-completions",
          apiKey: "test-openai-key",
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
    { provider: "anthropic", apiKey: "test-anthropic-key" },
    { provider: "openai", apiKey: "test-openai-key" },
  ];
}

function makeRequest(path: string, port: number): Request {
  return new Request(`http://localhost:${port}${path}`, { method: "POST" });
}

describe("handleApiRequest", () => {
  it("routes an Anthropic request to the correct model", async () => {
    const config = makeConfig();
    const openclawConfig = makeOpenClawConfig(`http://localhost:${mockPort}`);
    const authProfiles = makeAuthProfiles();
    mockResponseStatus = 200;
    mockSseMode = false;

    const body = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      max_tokens: 1024,
    };

    const response = await handleApiRequest(
      makeRequest("/v1/messages", mockPort),
      body,
      "anthropic-messages",
      config,
      openclawConfig,
      authProfiles,
    );

    expect(response.status).toBe(200);
    expect(lastReceivedBody).toBeDefined();
    expect(lastReceivedBody?.model).toBeTypeOf("string");
    expect(lastReceivedHeaders["x-api-key"]).toBe("test-anthropic-key");
  });

  it("routes an OpenAI request correctly", async () => {
    const config = makeConfig({
      models: {
        LIGHT: "openai/gpt-4o-mini",
        MEDIUM: "openai/gpt-4o",
        HEAVY: "openai/gpt-4o",
      },
    });
    const openclawConfig = makeOpenClawConfig(`http://localhost:${mockPort}`);
    const authProfiles = makeAuthProfiles();
    mockResponseStatus = 200;
    mockSseMode = false;

    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi there" }],
      stream: false,
    };

    const response = await handleApiRequest(
      makeRequest("/v1/chat/completions", mockPort),
      body,
      "openai-completions",
      config,
      openclawConfig,
      authProfiles,
    );

    expect(response.status).toBe(200);
    expect(lastReceivedBody).toBeDefined();
    expect(lastReceivedHeaders["authorization"]).toContain("Bearer");
  });

  it("routes trivial message to LIGHT model", async () => {
    const config = makeConfig({
      models: {
        LIGHT: "anthropic/claude-3-5-haiku-20241022",
        MEDIUM: "anthropic/claude-sonnet-4-20250514",
        HEAVY: "anthropic/claude-opus-4-20250514",
      },
    });
    const openclawConfig = makeOpenClawConfig(`http://localhost:${mockPort}`);
    const authProfiles = makeAuthProfiles();
    mockResponseStatus = 200;
    mockSseMode = false;

    const body = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      max_tokens: 1024,
    };

    const response = await handleApiRequest(
      makeRequest("/v1/messages", mockPort),
      body,
      "anthropic-messages",
      config,
      openclawConfig,
      authProfiles,
    );

    expect(response.status).toBe(200);
    expect(lastReceivedBody?.model).toBe("claude-3-5-haiku-20241022");
  });

  it("routes complex message to HEAVY model", async () => {
    const config = makeConfig({
      models: {
        LIGHT: "anthropic/claude-3-5-haiku-20241022",
        MEDIUM: "anthropic/claude-sonnet-4-20250514",
        HEAVY: "anthropic/claude-opus-4-20250514",
      },
    });
    const openclawConfig = makeOpenClawConfig(`http://localhost:${mockPort}`);
    const authProfiles = makeAuthProfiles();
    mockResponseStatus = 200;
    mockSseMode = false;

    const complexMessage = [
      "Implement a distributed consensus algorithm using Raft protocol. ",
      "The implementation should handle leader election, log replication, and safety guarantees. ",
      "Include proper error handling for network partitions and node failures. ",
      "Write comprehensive unit tests and integration tests. ",
      "Optimize for performance with batched log entries. ",
      "Additionally, analyze the time complexity of each operation and also explain ",
      "the trade-offs between consistency and availability in this context. ",
      "Refactor the existing codebase to use dependency injection patterns. ",
      "Debug the race condition in the concurrent access module. ",
      "Architect a microservices solution with proper API gateway integration.",
    ].join("");

    const body = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: complexMessage }],
      stream: true,
      max_tokens: 8192,
    };

    const response = await handleApiRequest(
      makeRequest("/v1/messages", mockPort),
      body,
      "anthropic-messages",
      config,
      openclawConfig,
      authProfiles,
    );

    expect(response.status).toBe(200);
    expect(lastReceivedBody?.model).toBe("claude-opus-4-20250514");
  });

  it("streams SSE response transparently", async () => {
    const config = makeConfig();
    const openclawConfig = makeOpenClawConfig(`http://localhost:${mockPort}`);
    const authProfiles = makeAuthProfiles();
    mockSseMode = true;

    const body = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      max_tokens: 1024,
    };

    const response = await handleApiRequest(
      makeRequest("/v1/messages", mockPort),
      body,
      "anthropic-messages",
      config,
      openclawConfig,
      authProfiles,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("event: message_stop");

    mockSseMode = false;
  });

  it("returns 502 when no auth credentials found", async () => {
    const config = makeConfig();
    const openclawConfig: OpenClawConfig = {
      models: {
        providers: {
          anthropic: {
            baseUrl: `http://localhost:${mockPort}`,
            api: "anthropic-messages",
            models: [
              { id: "claude-3-5-haiku-20241022" },
              { id: "claude-sonnet-4-20250514" },
              { id: "claude-opus-4-20250514" },
            ],
          },
        },
      },
    };

    const body = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      max_tokens: 1024,
    };

    const response = await handleApiRequest(
      makeRequest("/v1/messages", mockPort),
      body,
      "anthropic-messages",
      config,
      openclawConfig,
      [],
    );

    expect(response.status).toBe(502);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("returns 500 for unknown API type", async () => {
    const config = makeConfig();
    const openclawConfig = makeOpenClawConfig(`http://localhost:${mockPort}`);
    const authProfiles = makeAuthProfiles();

    const response = await handleApiRequest(
      makeRequest("/v1/messages", mockPort),
      {},
      "unknown-api",
      config,
      openclawConfig,
      authProfiles,
    );

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toContain("Unknown API type");
  });

  it("pipes upstream non-2xx responses as-is", async () => {
    const config = makeConfig();
    const openclawConfig = makeOpenClawConfig(`http://localhost:${mockPort}`);
    const authProfiles = makeAuthProfiles();
    mockResponseStatus = 429;
    mockResponseBody = '{"error":{"type":"rate_limit_error","message":"Too many requests"}}';

    const body = {
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      max_tokens: 1024,
    };

    const response = await handleApiRequest(
      makeRequest("/v1/messages", mockPort),
      body,
      "anthropic-messages",
      config,
      openclawConfig,
      authProfiles,
    );

    expect(response.status).toBe(429);
    const json = await response.json();
    expect(json.error.type).toBe("rate_limit_error");

    mockResponseStatus = 200;
    mockResponseBody = '{"id":"msg_test","content":[{"type":"text","text":"Hello!"}]}';
  });
});

describe("setupPipelineRoutes", () => {
  it("is exported and callable", async () => {
    const { setupPipelineRoutes } = await import("./pipeline.ts");
    expect(typeof setupPipelineRoutes).toBe("function");
  });
});
