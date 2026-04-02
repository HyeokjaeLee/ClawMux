import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { classifyComplexity } from "./llm-classifier.ts";
import type { ClassifierDeps } from "./llm-classifier.ts";
import type { Message } from "./types.ts";
import { registerAdapter } from "../adapters/registry.ts";
import { AnthropicAdapter } from "../adapters/anthropic.ts";

registerAdapter(new AnthropicAdapter());

const MOCK_OPENCLAW_CONFIG = {
  models: {
    providers: {
      anthropic: {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        apiKey: "test-key-123",
      },
    },
  },
};

const MOCK_AUTH_PROFILES = [
  { provider: "anthropic", apiKey: "test-key-123" },
];

function makeDeps(overrides?: Partial<ClassifierDeps>): ClassifierDeps {
  return {
    openclawConfig: MOCK_OPENCLAW_CONFIG,
    authProfiles: MOCK_AUTH_PROFILES,
    classifierModel: "anthropic/claude-3-5-haiku-20241022",
    timeoutMs: 3000,
    routingModels: {
      LIGHT: "anthropic/claude-3-5-haiku-20241022",
      MEDIUM: "anthropic/claude-sonnet-4-20250514",
      HEAVY: "anthropic/claude-opus-4-20250514",
    },
    ...overrides,
  };
}

function mockAnthropicResponse(text: string, ok = true, status = 200): Response {
  const body = JSON.stringify({
    content: [{ type: "text", text }],
  });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(impl: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  const mocked = mock(impl);
  const fetchWithPreconnect = Object.assign(mocked, {
    preconnect: (_url: string | URL) => {},
  }) as unknown as typeof globalThis.fetch;
  return fetchWithPreconnect;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("classifyComplexity", () => {
  test("valid LIGHT classification", async () => {
    globalThis.fetch = mockFetch(() => Promise.resolve(mockAnthropicResponse("LIGHT")));

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("LIGHT");
    expect(result.confidence).toBe(1.0);
  });

  test("valid MEDIUM classification", async () => {
    globalThis.fetch = mockFetch(() => Promise.resolve(mockAnthropicResponse("MEDIUM")));

    const messages: Message[] = [{ role: "user", content: "Write a function to sort an array" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("MEDIUM");
    expect(result.confidence).toBe(1.0);
  });

  test("valid HEAVY classification", async () => {
    globalThis.fetch = mockFetch(() => Promise.resolve(mockAnthropicResponse("HEAVY")));

    const messages: Message[] = [{ role: "user", content: "Design a distributed system" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(1.0);
  });

  test("case insensitive tier parsing", async () => {
    globalThis.fetch = mockFetch(() => Promise.resolve(mockAnthropicResponse("light")));

    const messages: Message[] = [{ role: "user", content: "hi" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("LIGHT");
    expect(result.confidence).toBe(1.0);
  });

  test("response with reasoning on second line", async () => {
    globalThis.fetch = mockFetch(() =>
      Promise.resolve(mockAnthropicResponse("HEAVY\nComplex architecture question requiring deep analysis")),
    );

    const messages: Message[] = [{ role: "user", content: "Design a microservice architecture" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(1.0);
    expect(result.reasoning).toBe("Complex architecture question requiring deep analysis");
  });

  test("invalid LLM response falls back to keyword scorer", async () => {
    globalThis.fetch = mockFetch(() =>
      Promise.resolve(mockAnthropicResponse("I don't know how to classify this")),
    );

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.reasoning).toBe("Keyword scorer fallback");
  });

  test("timeout falls back to keyword scorer", async () => {
    globalThis.fetch = mockFetch(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(mockAnthropicResponse("LIGHT")), 10000)),
    );

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(messages, makeDeps({ timeoutMs: 50 }));

    expect(result.reasoning).toBe("Keyword scorer fallback");
  });

  test("network error falls back to keyword scorer", async () => {
    globalThis.fetch = mockFetch(() => Promise.reject(new Error("Network failure")));

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.reasoning).toBe("Keyword scorer fallback");
  });

  test("empty messages returns HEAVY with confidence 0.0", async () => {
    const mocked = mockFetch(() => Promise.resolve(mockAnthropicResponse("LIGHT")));
    globalThis.fetch = mocked;

    const result = await classifyComplexity([], makeDeps());

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(0.0);
    expect(mocked).not.toHaveBeenCalled();
  });

  test("only assistant messages returns HEAVY with confidence 0.0", async () => {
    const mocked = mockFetch(() => Promise.resolve(mockAnthropicResponse("LIGHT")));
    globalThis.fetch = mocked;

    const messages: Message[] = [
      { role: "assistant", content: "Hello, how can I help?" },
      { role: "assistant", content: "I can assist with many things." },
    ];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(0.0);
    expect(mocked).not.toHaveBeenCalled();
  });

  test("long message is truncated to 500 chars in API call", async () => {
    let capturedBody = "";
    globalThis.fetch = mockFetch((_url, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(mockAnthropicResponse("MEDIUM"));
    });

    const longText = "a".repeat(1000);
    const messages: Message[] = [{ role: "user", content: longText }];
    await classifyComplexity(messages, makeDeps());

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    const msgs = parsed.messages as Array<{ content: string }>;
    expect(msgs[0].content.length).toBeLessThanOrEqual(500);
  });

  test("provider/model resolution uses correct provider from openclaw config", async () => {
    let capturedUrl = "";
    globalThis.fetch = mockFetch((url) => {
      capturedUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
      return Promise.resolve(mockAnthropicResponse("LIGHT"));
    });

    const messages: Message[] = [{ role: "user", content: "hello" }];
    await classifyComplexity(messages, makeDeps());

    expect(capturedUrl).toContain("api.anthropic.com");
  });

  test("system messages are not sent to classifier", async () => {
    let capturedBody = "";
    globalThis.fetch = mockFetch((_url, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(mockAnthropicResponse("LIGHT"));
    });

    const messages: Message[] = [
      { role: "system", content: "You are an expert architect analyzing complex distributed systems" },
      { role: "user", content: "hello" },
    ];
    await classifyComplexity(messages, makeDeps());

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    const msgs = parsed.messages as Array<{ role: string; content: string }>;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello");
  });

  test("array content format extracts text correctly", async () => {
    let capturedBody = "";
    globalThis.fetch = mockFetch((_url, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(mockAnthropicResponse("LIGHT"));
    });

    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "hello world" },
          { type: "image" },
        ],
      },
    ];
    await classifyComplexity(messages, makeDeps());

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    const msgs = parsed.messages as Array<{ content: string }>;
    expect(msgs[0].content).toBe("hello world");
  });

  test("uses last user message only, ignoring earlier ones", async () => {
    let capturedBody = "";
    globalThis.fetch = mockFetch((_url, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(mockAnthropicResponse("LIGHT"));
    });

    const messages: Message[] = [
      { role: "user", content: "Design a complex distributed system" },
      { role: "assistant", content: "Here is my analysis..." },
      { role: "user", content: "thanks" },
    ];
    await classifyComplexity(messages, makeDeps());

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    const msgs = parsed.messages as Array<{ content: string }>;
    expect(msgs[0].content).toBe("thanks");
  });

  test("HTTP error response falls back to keyword scorer", async () => {
    globalThis.fetch = mockFetch(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    );

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.reasoning).toBe("Keyword scorer fallback");
  });

  test("unknown provider falls back to keyword scorer", async () => {
    const mocked = mockFetch(() => Promise.resolve(mockAnthropicResponse("LIGHT")));
    globalThis.fetch = mocked;

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(
      messages,
      makeDeps({ classifierModel: "unknown-provider/some-model" }),
    );

    expect(result.reasoning).toBe("Keyword scorer fallback");
    expect(mocked).not.toHaveBeenCalled();
  });
});
