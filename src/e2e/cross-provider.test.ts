import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createServer } from "../proxy/server.ts";
import { setupPipelineRoutes } from "../proxy/pipeline.ts";
import { clearCustomHandlers } from "../proxy/router.ts";
import type { ClawMuxConfig } from "../config/types.ts";
import type { OpenClawConfig, AuthProfile } from "../openclaw/types.ts";

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

let lastAnthropicRequest: CapturedRequest | null = null;
let lastOpenAIRequest: CapturedRequest | null = null;

const ANTHROPIC_RESPONSE_BODY = JSON.stringify({
  id: "msg_cross_test",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "Hello from Anthropic mock" }],
  model: "claude-sonnet-4-20250514",
  stop_reason: "end_turn",
  usage: { input_tokens: 12, output_tokens: 8 },
});

const OPENAI_RESPONSE_BODY = JSON.stringify({
  id: "chatcmpl-cross-test",
  object: "chat.completion",
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from OpenAI mock" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 },
});

function makeOpenAIStreamBody(): string {
  const chunks = [
    `data: ${JSON.stringify({
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return chunks.join("");
}

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

const MEDIUM_CONTENT = [
  "Write a quicksort function in TypeScript with proper type annotations. ",
  "Handle edge cases like empty arrays and arrays with duplicate values. ",
  "Add unit tests to verify the sorting behavior.",
].join("");

let mockAnthropicUpstream: ReturnType<typeof Bun.serve>;
let mockAnthropicPort: number;

let mockOpenAIUpstream: ReturnType<typeof Bun.serve>;
let mockOpenAIPort: number;

let proxyServer: ReturnType<typeof createServer>;
let proxyPort: number;

async function captureRequest(req: Request): Promise<CapturedRequest> {
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
  return { method: req.method, path, headers, body };
}

let anthropicStreamMode = false;
let openaiStreamMode = false;
beforeAll(() => {
  mockAnthropicUpstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = await req.text();
      let parsedBody: Record<string, unknown> | null = null;
      if (text) {
        parsedBody = JSON.parse(text) as Record<string, unknown>;
      }

      lastAnthropicRequest = {
        method: req.method,
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body: parsedBody,
      };

      if (anthropicStreamMode) {
        const streamBody = [
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: { id: "msg_stream", type: "message", role: "assistant", model: "claude-sonnet-4-20250514" },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Streamed from Anthropic" },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ].join("");

        return new Response(streamBody, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      return new Response(ANTHROPIC_RESPONSE_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  mockAnthropicPort = mockAnthropicUpstream.port as number;

  mockOpenAIUpstream = Bun.serve({
    port: 0,
    async fetch(req) {
      lastOpenAIRequest = await captureRequest(req);

      if (openaiStreamMode) {
        return new Response(makeOpenAIStreamBody(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      return new Response(OPENAI_RESPONSE_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  mockOpenAIPort = mockOpenAIUpstream.port as number;

  const tempServer = Bun.serve({ port: 0, fetch: () => new Response("") });
  proxyPort = tempServer.port as number;
  tempServer.stop(true);

  const config: ClawMuxConfig = {
    compression: {
      threshold: 0.75,
      model: "test-anthropic/claude-sonnet-4-20250514",
      targetRatio: 0.6,
    },
    routing: {
      models: {
        LIGHT: "test-openai/gpt-4o-mini",
        MEDIUM: "test-anthropic/claude-sonnet-4-20250514",
        HEAVY: "test-openai/gpt-5.4",
      },

    },
    server: { port: 0, host: "127.0.0.1" },
  };

  const openclawConfig: OpenClawConfig = {
    models: {
      providers: {
        "test-anthropic": {
          baseUrl: `http://127.0.0.1:${mockAnthropicPort}`,
          api: "anthropic-messages",
          apiKey: "test-key",
          models: [{ id: "claude-sonnet-4-20250514" }],
        },
        "test-openai": {
          baseUrl: `http://127.0.0.1:${mockOpenAIPort}`,
          api: "openai-completions",
          apiKey: "sk-test",
          models: [{ id: "gpt-4o-mini" }, { id: "gpt-5.4" }],
        },
      },
    },
  };

  const authProfiles: AuthProfile[] = [
    { provider: "test-anthropic", apiKey: "test-key" },
    { provider: "test-openai", apiKey: "sk-test" },
  ];

  setupPipelineRoutes(config, openclawConfig, authProfiles, undefined);

  proxyServer = createServer({ port: proxyPort, host: "127.0.0.1" });
  proxyServer.start();
});

afterAll(() => {
  proxyServer.stop();
  mockAnthropicUpstream.stop(true);
  mockOpenAIUpstream.stop(true);
  clearCustomHandlers();
});

function proxyUrl(path: string): string {
  return `http://127.0.0.1:${proxyPort}${path}`;
}

function resetState(): void {
  lastAnthropicRequest = null;
  lastOpenAIRequest = null;
  anthropicStreamMode = false;
  openaiStreamMode = false;
}

describe("Cross-provider routing", () => {
  test("Anthropic→OpenAI (non-streaming): response translated to Anthropic format", async () => {
    resetState();

    const res = await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
        stream: false,
      }),
    });

    expect(res.status).toBe(200);

    expect(lastOpenAIRequest).not.toBeNull();
    expect(lastAnthropicRequest).toBeNull();

    expect(lastOpenAIRequest!.path).toBe("/v1/chat/completions");
    expect(lastOpenAIRequest!.headers["authorization"]).toContain("Bearer");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe("message");
    expect(body.role).toBe("assistant");

    const content = body.content as Array<{ type: string; text: string }>;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe("text");
    expect(typeof content[0].text).toBe("string");
  });

  test("Anthropic→OpenAI (streaming): SSE uses Anthropic event types", async () => {
    resetState();
    openaiStreamMode = true;

    const res = await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(lastOpenAIRequest).not.toBeNull();
    expect(lastAnthropicRequest).toBeNull();

    const text = await res.text();

    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("event: message_stop");

    expect(text).not.toContain('"object":"chat.completion.chunk"');
  });

  test("Anthropic→Anthropic (same provider): response piped transparently", async () => {
    resetState();

    const res = await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: MEDIUM_CONTENT }],
        max_tokens: 4096,
        stream: false,
      }),
    });

    expect(res.status).toBe(200);

    expect(lastAnthropicRequest).not.toBeNull();
    expect(lastOpenAIRequest).toBeNull();

    expect(lastAnthropicRequest!.path).toBe("/v1/messages");
    expect(lastAnthropicRequest!.headers["x-api-key"]).toBe("test-key");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("msg_cross_test");
    expect(body.type).toBe("message");
    expect(body.model).toBe("claude-sonnet-4-20250514");
  });

  test("OpenAI→Anthropic: response translated to OpenAI format", async () => {
    resetState();

    const res = await fetch(proxyUrl("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: MEDIUM_CONTENT }],
        max_tokens: 4096,
      }),
    });

    expect(res.status).toBe(200);

    expect(lastAnthropicRequest).not.toBeNull();
    expect(lastOpenAIRequest).toBeNull();

    expect(lastAnthropicRequest!.path).toBe("/v1/messages");
    expect(lastAnthropicRequest!.headers["x-api-key"]).toBe("test-key");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.object).toBe("chat.completion");

    const choices = body.choices as Array<Record<string, unknown>>;
    expect(Array.isArray(choices)).toBe(true);
    expect(choices.length).toBeGreaterThan(0);

    const message = choices[0].message as Record<string, unknown>;
    expect(message.role).toBe("assistant");
    expect(typeof message.content).toBe("string");
  });

  test("Model field verification: upstream receives correct target model name", async () => {
    resetState();

    await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 256,
        stream: false,
      }),
    });

    expect(lastOpenAIRequest).not.toBeNull();
    const sentModel = lastOpenAIRequest!.body?.model as string;
    expect(sentModel).toBe("gpt-4o-mini");

    resetState();

    await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: MEDIUM_CONTENT }],
        max_tokens: 4096,
        stream: false,
      }),
    });

    expect(lastAnthropicRequest).not.toBeNull();
    const sentMediumModel = lastAnthropicRequest!.body?.model as string;
    expect(sentMediumModel).toBe("claude-sonnet-4-20250514");

    resetState();

    await fetch(proxyUrl("/v1/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-20250514",
        messages: [{ role: "user", content: COMPLEX_CONTENT }],
        max_tokens: 8192,
        stream: false,
      }),
    });

    expect(lastOpenAIRequest).not.toBeNull();
    const sentHeavyModel = lastOpenAIRequest!.body?.model as string;
    expect(sentHeavyModel).toBe("gpt-5.4");
  });
});
