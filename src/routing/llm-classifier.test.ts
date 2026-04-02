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
    contextMessages: 10,
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
  test("valid L → LIGHT classification", async () => {
    globalThis.fetch = mockFetch(() => Promise.resolve(mockAnthropicResponse("L")));

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("LIGHT");
    expect(result.confidence).toBe(1.0);
    expect(result.error).toBeUndefined();
  });

  test("valid M → MEDIUM classification", async () => {
    globalThis.fetch = mockFetch(() => Promise.resolve(mockAnthropicResponse("M")));

    const messages: Message[] = [{ role: "user", content: "Write a function to sort an array" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("MEDIUM");
    expect(result.confidence).toBe(1.0);
  });

  test("valid H → HEAVY classification", async () => {
    globalThis.fetch = mockFetch(() => Promise.resolve(mockAnthropicResponse("H")));

    const messages: Message[] = [{ role: "user", content: "Design a distributed system" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(1.0);
  });

  test("case insensitive: l → LIGHT", async () => {
    globalThis.fetch = mockFetch(() => Promise.resolve(mockAnthropicResponse("l")));

    const messages: Message[] = [{ role: "user", content: "hi" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("LIGHT");
    expect(result.confidence).toBe(1.0);
  });

  test("case insensitive: m → MEDIUM", async () => {
    globalThis.fetch = mockFetch(() => Promise.resolve(mockAnthropicResponse("m")));

    const messages: Message[] = [{ role: "user", content: "explain closures" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("MEDIUM");
  });

  test("case insensitive: h → HEAVY", async () => {
    globalThis.fetch = mockFetch(() => Promise.resolve(mockAnthropicResponse("h")));

    const messages: Message[] = [{ role: "user", content: "design microservices" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("HEAVY");
  });

  test("case insensitive: q triggers context re-classification", async () => {
    let callCount = 0;
    globalThis.fetch = mockFetch(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(mockAnthropicResponse("q"));
      return Promise.resolve(mockAnthropicResponse("M"));
    });

    const messages: Message[] = [
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "which thing?" },
      { role: "user", content: "that thing" },
    ];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("MEDIUM");
    expect(callCount).toBe(2);
  });

  test("Q → re-classification with context messages", async () => {
    let callCount = 0;
    let capturedBodies: string[] = [];
    globalThis.fetch = mockFetch((_url, init) => {
      callCount++;
      capturedBodies.push(typeof init?.body === "string" ? init.body : "");
      if (callCount === 1) return Promise.resolve(mockAnthropicResponse("Q"));
      return Promise.resolve(mockAnthropicResponse("H"));
    });

    const messages: Message[] = [
      { role: "user", content: "Design a complex system" },
      { role: "assistant", content: "Here is my analysis..." },
      { role: "user", content: "now refactor it" },
    ];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(0.9);
    expect(result.reasoning).toBe("Classified with conversation context");
    expect(callCount).toBe(2);

    const secondBody = JSON.parse(capturedBodies[1]) as Record<string, unknown>;
    const msgs = secondBody.messages as Array<{ role: string; content: string }>;
    expect(msgs.length).toBeGreaterThan(1);
    expect(msgs[msgs.length - 1].content).toBe("now refactor it");
  });

  test("Q re-classification uses prompt without Q option, invalid response returns error", async () => {
    let callCount = 0;
    let lastBody = "";
    globalThis.fetch = mockFetch((_url, init) => {
      callCount++;
      if (init?.body) lastBody = typeof init.body === "string" ? init.body : "";
      return Promise.resolve(mockAnthropicResponse("Q"));
    });

    const messages: Message[] = [{ role: "user", content: "do something" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(0.0);
    expect(result.error).toBeDefined();
    // Re-classification prompt should NOT contain Q option
    expect(lastBody).not.toContain("Q -");
  });

  test("format error → retry → success", async () => {
    let callCount = 0;
    globalThis.fetch = mockFetch(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(mockAnthropicResponse("I don't know"));
      return Promise.resolve(mockAnthropicResponse("L"));
    });

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("LIGHT");
    expect(result.confidence).toBe(1.0);
    expect(callCount).toBe(2);
  });

  test("format error → retry → retry → fail → error to user", async () => {
    globalThis.fetch = mockFetch(() =>
      Promise.resolve(mockAnthropicResponse("I cannot classify this")),
    );

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(0.0);
    expect(result.error).toContain("Classification failed after 3 attempts");
  });

  test("error feedback message format is correct", async () => {
    let capturedBodies: string[] = [];
    let callCount = 0;
    globalThis.fetch = mockFetch((_url, init) => {
      callCount++;
      capturedBodies.push(typeof init?.body === "string" ? init.body : "");
      if (callCount <= 2) return Promise.resolve(mockAnthropicResponse("INVALID"));
      return Promise.resolve(mockAnthropicResponse("M"));
    });

    const messages: Message[] = [{ role: "user", content: "test message" }];
    await classifyComplexity(messages, makeDeps());

    expect(callCount).toBe(3);

    const retryBody = JSON.parse(capturedBodies[1]) as Record<string, unknown>;
    const retryMsgs = retryBody.messages as Array<{ role: string; content: string }>;
    expect(retryMsgs).toHaveLength(3);
    expect(retryMsgs[0]).toEqual({ role: "user", content: "test message" });
    expect(retryMsgs[1].role).toBe("assistant");
    expect(retryMsgs[2]).toEqual({
      role: "user",
      content: "Invalid response. Reply with exactly one character: L, M, H, or Q",
    });
  });

  test("timeout → error (not keyword fallback)", async () => {
    globalThis.fetch = mockFetch(
      () => new Promise<Response>((resolve) => setTimeout(() => resolve(mockAnthropicResponse("L")), 10000)),
    );

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(messages, makeDeps({ timeoutMs: 50 }));

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(0.0);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Classifier timeout");
    expect(result.reasoning).not.toBe("Keyword scorer fallback");
  });

  test("network error → error (not keyword fallback)", async () => {
    globalThis.fetch = mockFetch(() => Promise.reject(new Error("Network failure")));

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(0.0);
    expect(result.error).toContain("Network failure");
    expect(result.reasoning).not.toBe("Keyword scorer fallback");
  });

  test("empty messages → HEAVY with error", async () => {
    const mocked = mockFetch(() => Promise.resolve(mockAnthropicResponse("L")));
    globalThis.fetch = mocked;

    const result = await classifyComplexity([], makeDeps());

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(0.0);
    expect(result.error).toBeDefined();
    expect(mocked).not.toHaveBeenCalled();
  });

  test("only assistant messages → HEAVY with error", async () => {
    const mocked = mockFetch(() => Promise.resolve(mockAnthropicResponse("L")));
    globalThis.fetch = mocked;

    const messages: Message[] = [
      { role: "assistant", content: "Hello, how can I help?" },
      { role: "assistant", content: "I can assist with many things." },
    ];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(0.0);
    expect(result.error).toBeDefined();
    expect(mocked).not.toHaveBeenCalled();
  });

  test("max_tokens=1 is set in the API call", async () => {
    let capturedBody = "";
    globalThis.fetch = mockFetch((_url, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(mockAnthropicResponse("M"));
    });

    const messages: Message[] = [{ role: "user", content: "test" }];
    await classifyComplexity(messages, makeDeps());

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(parsed.max_tokens).toBe(1);
  });

  test("long message is truncated to 500 chars in API call", async () => {
    let capturedBody = "";
    globalThis.fetch = mockFetch((_url, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(mockAnthropicResponse("M"));
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
      return Promise.resolve(mockAnthropicResponse("L"));
    });

    const messages: Message[] = [{ role: "user", content: "hello" }];
    await classifyComplexity(messages, makeDeps());

    expect(capturedUrl).toContain("api.anthropic.com");
  });

  test("system messages are not sent to classifier", async () => {
    let capturedBody = "";
    globalThis.fetch = mockFetch((_url, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(mockAnthropicResponse("L"));
    });

    const messages: Message[] = [
      { role: "system", content: "You are an expert architect" },
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
      return Promise.resolve(mockAnthropicResponse("L"));
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

  test("uses last user message only for initial classification", async () => {
    let capturedBody = "";
    globalThis.fetch = mockFetch((_url, init) => {
      capturedBody = typeof init?.body === "string" ? init.body : "";
      return Promise.resolve(mockAnthropicResponse("L"));
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

  test("HTTP error response → error (not keyword fallback)", async () => {
    globalThis.fetch = mockFetch(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 })),
    );

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(0.0);
    expect(result.error).toBeDefined();
    expect(result.reasoning).not.toBe("Keyword scorer fallback");
  });

  test("unknown provider → error (not keyword fallback)", async () => {
    const mocked = mockFetch(() => Promise.resolve(mockAnthropicResponse("L")));
    globalThis.fetch = mocked;

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(
      messages,
      makeDeps({ classifierModel: "unknown-provider/some-model" }),
    );

    expect(result.tier).toBe("HEAVY");
    expect(result.confidence).toBe(0.0);
    expect(result.error).toBeDefined();
    expect(mocked).not.toHaveBeenCalled();
  });

  test("Q re-classification respects contextMessages config", async () => {
    let callCount = 0;
    let capturedBodies: string[] = [];
    globalThis.fetch = mockFetch((_url, init) => {
      callCount++;
      capturedBodies.push(typeof init?.body === "string" ? init.body : "");
      if (callCount === 1) return Promise.resolve(mockAnthropicResponse("Q"));
      return Promise.resolve(mockAnthropicResponse("L"));
    });

    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: `message ${i}` });
      messages.push({ role: "assistant", content: `response ${i}` });
    }
    messages.push({ role: "user", content: "final question" });

    await classifyComplexity(messages, makeDeps({ contextMessages: 5 }));

    const secondBody = JSON.parse(capturedBodies[1]) as Record<string, unknown>;
    const msgs = secondBody.messages as Array<{ role: string; content: string }>;
    expect(msgs.length).toBeLessThanOrEqual(6);
  });

  test("first character only is used for parsing", async () => {
    globalThis.fetch = mockFetch(() => Promise.resolve(mockAnthropicResponse("L extra text")));

    const messages: Message[] = [{ role: "user", content: "hello" }];
    const result = await classifyComplexity(messages, makeDeps());

    expect(result.tier).toBe("LIGHT");
    expect(result.confidence).toBe(1.0);
  });
});
