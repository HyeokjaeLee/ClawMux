import { describe, expect, it, beforeEach } from "bun:test";
import type { ApiAdapter, AuthInfo, ParsedRequest, UpstreamRequest } from "../adapters/types.ts";
import type { Session } from "../compression/types.ts";
import { createCompressionMiddleware } from "./compression-integration.ts";
import type { CompressionMiddleware, CompressionMiddlewareConfig } from "./compression-integration.ts";
import { createStatsTracker } from "./stats.ts";

function createMockAdapter(): ApiAdapter {
  return {
    apiType: "test-adapter",
    parseRequest(body: unknown): ParsedRequest {
      const raw = body as Record<string, unknown>;
      return {
        model: String(raw.model ?? ""),
        messages: (raw.messages ?? []) as Array<{ role: string; content: unknown }>,
        stream: false,
        rawBody: raw,
      };
    },
    buildUpstreamRequest(
      parsed: ParsedRequest,
      targetModel: string,
      baseUrl: string,
      auth: AuthInfo,
    ): UpstreamRequest {
      return {
        url: `${baseUrl}/v1/messages`,
        method: "POST",
        headers: {
          "x-api-key": auth.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...parsed.rawBody,
          model: targetModel,
        }),
      };
    },
    modifyMessages(
      rawBody: Record<string, unknown>,
      compressedMessages: Array<{ role: string; content: unknown }>,
    ): Record<string, unknown> {
      return { ...rawBody, messages: compressedMessages };
    },
  };
}

const TEST_AUTH: AuthInfo = {
  apiKey: "test-key",
  headerName: "x-api-key",
  headerValue: "test-key",
};

const BASE_CONFIG: CompressionMiddlewareConfig = {
  threshold: 0.75,
  targetRatio: 0.6,
  compressionModel: "test-compression-model",
  resolvedContextWindow: 1000,
  maxSessions: 10,
};

function makeParsed(messages: Array<{ role: string; content: string }>): ParsedRequest {
  return {
    model: "test-model",
    messages,
    stream: false,
    rawBody: { model: "test-model", messages, stream: false },
  };
}

describe("createCompressionMiddleware", () => {
  let middleware: CompressionMiddleware;
  let adapter: ApiAdapter;

  beforeEach(() => {
    adapter = createMockAdapter();
    middleware = createCompressionMiddleware(BASE_CONFIG);
  });

  describe("beforeForward", () => {
    it("returns original messages with wasCompressed=false when no compression ready", () => {
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];
      const parsed = makeParsed(messages);

      const result = middleware.beforeForward(parsed, adapter);

      expect(result.wasCompressed).toBe(false);
      expect(result.messages).toEqual(messages);
    });

    it("skips compression for empty messages", () => {
      const parsed = makeParsed([]);

      const result = middleware.beforeForward(parsed, adapter);

      expect(result.wasCompressed).toBe(false);
      expect(result.messages).toEqual([]);
    });

    it("skips compression for single message", () => {
      const parsed = makeParsed([{ role: "user", content: "Hello" }]);

      const result = middleware.beforeForward(parsed, adapter);

      expect(result.wasCompressed).toBe(false);
      expect(result.messages).toHaveLength(1);
    });

    it("returns compressed messages when compression is ready", () => {
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
        { role: "assistant", content: "I'm doing well" },
      ];
      const parsed = makeParsed(messages);

      const store = middleware.getSessionStore();
      const sessionId = "session-" + String(hashContent("Hello"));
      const session: Session = {
        id: sessionId,
        messages,
        tokenCount: 800,
        compressionState: "ready",
        compressedSummary: "A greeting conversation",
        compressedMessages: [
          { role: "user", content: "[Summary of previous conversation]\nA greeting conversation" },
          { role: "assistant", content: "Understood. I have the context from our previous conversation. How can I help you continue?" },
        ],
        lastAccess: Date.now(),
      };
      store.set(sessionId, session);

      const result = middleware.beforeForward(parsed, adapter);

      expect(result.wasCompressed).toBe(true);
      expect(result.messages.length).toBeGreaterThanOrEqual(2);
      const firstContent = result.messages[0].content as string;
      expect(firstContent).toContain("[Summary of previous conversation]");
    });

    it("records stats when compression is applied", () => {
      const statsTracker = createStatsTracker();
      const mw = createCompressionMiddleware({ ...BASE_CONFIG, statsTracker });

      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
        { role: "user", content: "How are you?" },
      ];
      const parsed = makeParsed(messages);

      const store = mw.getSessionStore();
      const sessionId = "session-" + String(hashContent("Hello"));
      store.set(sessionId, {
        id: sessionId,
        messages,
        tokenCount: 800,
        compressionState: "ready",
        compressedSummary: "Summary",
        compressedMessages: [
          { role: "user", content: "[Summary of previous conversation]\nSummary" },
          { role: "assistant", content: "Understood." },
        ],
        lastAccess: Date.now(),
      });

      mw.beforeForward(parsed, adapter);

      const stats = statsTracker.getStats();
      expect(stats.compressions.total).toBe(1);
    });

    it("falls back to original messages on compression failure (state not ready)", () => {
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ];
      const parsed = makeParsed(messages);

      const store = middleware.getSessionStore();
      const sessionId = "session-" + String(hashContent("Hello"));
      store.set(sessionId, {
        id: sessionId,
        messages,
        tokenCount: 500,
        compressionState: "computing",
        lastAccess: Date.now(),
      });

      const result = middleware.beforeForward(parsed, adapter);

      expect(result.wasCompressed).toBe(false);
      expect(result.messages).toEqual(messages);
    });
  });

  describe("afterResponse", () => {
    it("updates session token count", () => {
      const messages = [
        { role: "user", content: "Hello world this is a test message" },
        { role: "assistant", content: "Hi there, how can I help you today?" },
      ];
      const parsed = makeParsed(messages);

      middleware.afterResponse(parsed, adapter, "http://localhost:3000", TEST_AUTH);

      const store = middleware.getSessionStore();
      const sessionId = "session-" + String(hashContent("Hello world this is a test message"));
      const session = store.get(sessionId);

      expect(session).toBeDefined();
      expect(session!.tokenCount).toBeGreaterThan(0);
      expect(session!.messages).toHaveLength(2);
    });

    it("triggers compression when threshold exceeded", async () => {
      const longContent = "x".repeat(4000);
      const messages = [
        { role: "user", content: longContent },
        { role: "assistant", content: longContent },
      ];
      const parsed = makeParsed(messages);

      const store = middleware.getSessionStore();
      const sessionId = "session-" + String(hashContent(longContent));
      store.set(sessionId, {
        id: sessionId,
        messages,
        tokenCount: 800,
        compressionState: "idle",
        lastAccess: Date.now(),
      });

      middleware.afterResponse(parsed, adapter, "http://localhost:3000", TEST_AUTH);

      const session = store.get(sessionId);
      expect(session).toBeDefined();
      expect(session!.compressionState).toBe("computing");
    });

    it("skips single-message conversations", () => {
      const parsed = makeParsed([{ role: "user", content: "Hello" }]);

      middleware.afterResponse(parsed, adapter, "http://localhost:3000", TEST_AUTH);

      const store = middleware.getSessionStore();
      expect(store.size()).toBe(0);
    });

    it("does not trigger compression when below threshold", () => {
      const messages = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
      ];
      const parsed = makeParsed(messages);

      middleware.afterResponse(parsed, adapter, "http://localhost:3000", TEST_AUTH);

      const store = middleware.getSessionStore();
      const sessionId = "session-" + String(hashContent("Hi"));
      const session = store.get(sessionId);

      expect(session).toBeDefined();
      expect(session!.compressionState).toBe("idle");
    });
  });

  describe("hard ceiling truncation", () => {
    it("truncates when tokens exceed 90% and compression not ready", () => {
      const mw = createCompressionMiddleware({
        ...BASE_CONFIG,
        resolvedContextWindow: 100,
        targetRatio: 0.6,
      });

      const longMessages = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} with enough words to push tokens over the hard ceiling limit`,
      }));
      const parsed = makeParsed(longMessages as Array<{ role: string; content: string }>);

      const store = mw.getSessionStore();
      const sessionId = "session-" + String(hashContent(longMessages[0].content));
      store.set(sessionId, {
        id: sessionId,
        messages: longMessages,
        tokenCount: 95,
        compressionState: "computing",
        lastAccess: Date.now(),
      });

      const result = mw.beforeForward(parsed, adapter);

      expect(result.wasCompressed).toBe(true);
      expect(result.messages.length).toBeLessThan(longMessages.length);
    });

    it("does not truncate when tokens are below 90%", () => {
      const mw = createCompressionMiddleware({
        ...BASE_CONFIG,
        resolvedContextWindow: 1000,
      });

      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ];
      const parsed = makeParsed(messages);

      const result = mw.beforeForward(parsed, adapter);

      expect(result.wasCompressed).toBe(false);
      expect(result.messages).toEqual(messages);
    });
  });

  describe("session store size limit", () => {
    it("respects maxSessions limit", () => {
      const mw = createCompressionMiddleware({ ...BASE_CONFIG, maxSessions: 3 });
      const store = mw.getSessionStore();

      for (let i = 0; i < 5; i++) {
        const messages = [
          { role: "user", content: `unique-message-${i}` },
          { role: "assistant", content: "response" },
        ];
        const parsed = makeParsed(messages);
        mw.beforeForward(parsed, adapter);
      }

      expect(store.size()).toBeLessThanOrEqual(3);
    });
  });

  describe("getSessionStore and getWorker", () => {
    it("exposes session store", () => {
      const store = middleware.getSessionStore();
      expect(store).toBeDefined();
      expect(typeof store.get).toBe("function");
      expect(typeof store.size).toBe("function");
    });

    it("exposes compression worker", () => {
      const worker = middleware.getWorker();
      expect(worker).toBeDefined();
      expect(typeof worker.shouldCompress).toBe("function");
      expect(typeof worker.applyCompression).toBe("function");
      expect(typeof worker.getStats).toBe("function");
    });
  });
});

function hashContent(content: string): number {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}
