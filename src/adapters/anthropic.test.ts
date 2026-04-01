import { describe, expect, it } from "bun:test";
import { AnthropicAdapter } from "./anthropic.ts";
import { getAdapter, registerAdapter } from "./registry.ts";
import type { AuthInfo, ParsedRequest } from "./types.ts";

const adapter = new AnthropicAdapter();

const baseAuth: AuthInfo = {
  apiKey: "sk-test-key",
  headerName: "x-api-key",
  headerValue: "sk-test-key",
};

describe("AnthropicAdapter", () => {
  describe("parseRequest", () => {
    it("parses a valid body into ParsedRequest", () => {
      const body = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
        max_tokens: 4096,
      };

      const result = adapter.parseRequest(body);

      expect(result.model).toBe("claude-sonnet-4-20250514");
      expect(result.messages).toEqual([{ role: "user", content: "Hello" }]);
      expect(result.stream).toBe(true);
      expect(result.maxTokens).toBe(4096);
      expect(result.system).toBeUndefined();
      expect(result.rawBody).toBe(body);
    });

    it("defaults stream to true when not specified", () => {
      const body = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1024,
      };

      const result = adapter.parseRequest(body);
      expect(result.stream).toBe(true);
    });

    it("respects stream: false", () => {
      const body = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hi" }],
        stream: false,
        max_tokens: 1024,
      };

      const result = adapter.parseRequest(body);
      expect(result.stream).toBe(false);
    });

    it("parses system as a string", () => {
      const body = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hi" }],
        system: "You are a helpful assistant.",
        max_tokens: 1024,
      };

      const result = adapter.parseRequest(body);
      expect(result.system).toBe("You are a helpful assistant.");
    });

    it("parses system as an array of content blocks", () => {
      const systemBlocks = [
        { type: "text", text: "You are a helpful assistant." },
        { type: "text", text: "Be concise." },
      ];
      const body = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hi" }],
        system: systemBlocks,
        max_tokens: 1024,
      };

      const result = adapter.parseRequest(body);
      expect(result.system).toEqual(systemBlocks);
    });
  });

  describe("buildUpstreamRequest", () => {
    it("builds correct URL, headers, and swaps model", () => {
      const parsed: ParsedRequest = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
        maxTokens: 4096,
        rawBody: {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
          max_tokens: 4096,
        },
      };

      const result = adapter.buildUpstreamRequest(
        parsed,
        "claude-sonnet-4-20250514",
        "https://api.anthropic.com",
        baseAuth,
      );

      expect(result.url).toBe("https://api.anthropic.com/v1/messages");
      expect(result.method).toBe("POST");
      expect(result.headers["x-api-key"]).toBe("sk-test-key");
      expect(result.headers["anthropic-version"]).toBe("2023-06-01");
      expect(result.headers["content-type"]).toBe("application/json");
      expect(result.headers["anthropic-beta"]).toBeUndefined();

      const body = JSON.parse(result.body);
      expect(body.model).toBe("claude-sonnet-4-20250514");
    });

    it("adds anthropic-beta header when thinking param is present", () => {
      const parsed: ParsedRequest = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Think about this" }],
        stream: true,
        maxTokens: 16000,
        rawBody: {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "Think about this" }],
          stream: true,
          max_tokens: 16000,
          thinking: { type: "enabled", budget_tokens: 10000 },
        },
      };

      const result = adapter.buildUpstreamRequest(
        parsed,
        "claude-sonnet-4-20250514",
        "https://api.anthropic.com",
        baseAuth,
      );

      expect(result.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14");

      const body = JSON.parse(result.body);
      expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
    });

    it("strips thinking and omits anthropic-beta for haiku models", () => {
      const parsed: ParsedRequest = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Quick question" }],
        stream: true,
        maxTokens: 16000,
        rawBody: {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "Quick question" }],
          stream: true,
          max_tokens: 16000,
          thinking: { type: "enabled", budget_tokens: 10000 },
        },
      };

      const result = adapter.buildUpstreamRequest(
        parsed,
        "claude-3-5-haiku-20241022",
        "https://api.anthropic.com",
        baseAuth,
      );

      expect(result.headers["anthropic-beta"]).toBeUndefined();

      const body = JSON.parse(result.body);
      expect(body.thinking).toBeUndefined();
      expect(body.model).toBe("claude-3-5-haiku-20241022");
    });

    it("swaps model to targetModel in body", () => {
      const parsed: ParsedRequest = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
        rawBody: {
          model: "claude-sonnet-4-20250514",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
          max_tokens: 2048,
        },
      };

      const result = adapter.buildUpstreamRequest(
        parsed,
        "claude-opus-4-20250514",
        "https://api.anthropic.com",
        baseAuth,
      );

      const body = JSON.parse(result.body);
      expect(body.model).toBe("claude-opus-4-20250514");
    });
  });

  describe("modifyMessages", () => {
    it("replaces messages while preserving other fields", () => {
      const rawBody = {
        model: "claude-sonnet-4-20250514",
        messages: [
          { role: "user", content: "Original message 1" },
          { role: "assistant", content: "Original response" },
          { role: "user", content: "Original message 2" },
        ],
        stream: true,
        max_tokens: 4096,
        system: "You are helpful.",
      };

      const compressedMessages = [
        { role: "user", content: "Compressed message" },
        { role: "assistant", content: "Compressed response" },
      ];

      const result = adapter.modifyMessages(rawBody, compressedMessages);

      expect(result.messages).toEqual(compressedMessages);
      expect(result.model).toBe("claude-sonnet-4-20250514");
      expect(result.stream).toBe(true);
      expect(result.max_tokens).toBe(4096);
      expect(result.system).toBe("You are helpful.");
    });

    it("does not mutate the original rawBody", () => {
      const rawBody = {
        model: "claude-sonnet-4-20250514",
        messages: [{ role: "user", content: "Original" }],
        max_tokens: 1024,
      };

      const newMessages = [{ role: "user", content: "New" }];
      adapter.modifyMessages(rawBody, newMessages);

      expect(rawBody.messages).toEqual([{ role: "user", content: "Original" }]);
    });
  });
});

describe("Adapter Registry", () => {
  it("returns adapter after registration", () => {
    registerAdapter(adapter);
    const found = getAdapter("anthropic-messages");
    expect(found).toBeDefined();
    expect(found?.apiType).toBe("anthropic-messages");
  });

  it("returns undefined for unknown apiType", () => {
    const found = getAdapter("unknown-api-type");
    expect(found).toBeUndefined();
  });
});
