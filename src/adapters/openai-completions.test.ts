import { describe, expect, test } from "bun:test";
import { openaiCompletionsAdapter } from "./openai-completions.ts";
import { getAdapter } from "./registry.ts";

const AUTH = {
  apiKey: "sk-test-key",
  headerName: "Authorization",
  headerValue: "Bearer sk-test-key",
};

describe("OpenAICompletionsAdapter", () => {
  test("apiType is openai-completions", () => {
    expect(openaiCompletionsAdapter.apiType).toBe("openai-completions");
  });

  test("is registered in adapter registry", () => {
    const adapter = getAdapter("openai-completions");
    expect(adapter).toBe(openaiCompletionsAdapter);
  });

  describe("parseRequest", () => {
    test("parses basic chat completions body", () => {
      const body = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      };

      const parsed = openaiCompletionsAdapter.parseRequest(body);

      expect(parsed.model).toBe("gpt-4o");
      expect(parsed.messages).toEqual([{ role: "user", content: "Hello" }]);
      expect(parsed.stream).toBe(false);
      expect(parsed.system).toBeUndefined();
    });

    test("extracts system message from messages array", () => {
      const body = {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "Hi" },
        ],
      };

      const parsed = openaiCompletionsAdapter.parseRequest(body);

      expect(parsed.system).toBe("You are helpful.");
      expect(parsed.messages).toEqual([{ role: "user", content: "Hi" }]);
    });

    test("extracts developer role as system message", () => {
      const body = {
        model: "gpt-4o",
        messages: [
          { role: "developer", content: "Be concise." },
          { role: "user", content: "Hi" },
        ],
      };

      const parsed = openaiCompletionsAdapter.parseRequest(body);

      expect(parsed.system).toBe("Be concise.");
      expect(parsed.messages).toEqual([{ role: "user", content: "Hi" }]);
    });

    test("handles content array format in system message", () => {
      const body = {
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: [{ type: "text", text: "System prompt" }],
          },
          { role: "user", content: "Hi" },
        ],
      };

      const parsed = openaiCompletionsAdapter.parseRequest(body);

      expect(parsed.system).toBe("System prompt");
    });

    test("parses max_tokens", () => {
      const body = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1024,
      };

      const parsed = openaiCompletionsAdapter.parseRequest(body);

      expect(parsed.maxTokens).toBe(1024);
    });

    test("parses stream: true", () => {
      const body = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
        stream: true,
      };

      const parsed = openaiCompletionsAdapter.parseRequest(body);

      expect(parsed.stream).toBe(true);
    });

    test("defaults stream to false when absent", () => {
      const body = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      };

      const parsed = openaiCompletionsAdapter.parseRequest(body);

      expect(parsed.stream).toBe(false);
    });

    test("preserves rawBody", () => {
      const body = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.7,
        top_p: 0.9,
      };

      const parsed = openaiCompletionsAdapter.parseRequest(body);

      expect(parsed.rawBody.temperature).toBe(0.7);
      expect(parsed.rawBody.top_p).toBe(0.9);
    });

    test("throws on missing model", () => {
      const body = {
        messages: [{ role: "user", content: "Hi" }],
      };

      expect(() => openaiCompletionsAdapter.parseRequest(body)).toThrow(
        "Missing required field: model",
      );
    });

    test("throws on invalid body", () => {
      expect(() => openaiCompletionsAdapter.parseRequest("not-object")).toThrow(
        "Request body must be a JSON object",
      );
    });

    test("throws on missing messages", () => {
      const body = { model: "gpt-4o" };

      expect(() => openaiCompletionsAdapter.parseRequest(body)).toThrow(
        "Request must contain a valid 'messages' or 'input' array",
      );
    });
  });

  describe("buildUpstreamRequest", () => {
    test("builds correct upstream request", () => {
      const parsed = openaiCompletionsAdapter.parseRequest({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0.5,
      });

      const upstream = openaiCompletionsAdapter.buildUpstreamRequest(
        parsed,
        "gpt-4o-mini",
        "https://api.openai.com",
        AUTH,
      );

      expect(upstream.url).toBe(
        "https://api.openai.com/v1/chat/completions",
      );
      expect(upstream.method).toBe("POST");
      expect(upstream.headers["Authorization"]).toBe("Bearer sk-test-key");
      expect(upstream.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(upstream.body);
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.temperature).toBe(0.5);
    });

    test("overrides model in upstream body", () => {
      const parsed = openaiCompletionsAdapter.parseRequest({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      });

      const upstream = openaiCompletionsAdapter.buildUpstreamRequest(
        parsed,
        "gpt-3.5-turbo",
        "https://custom.api.com",
        AUTH,
      );

      const body = JSON.parse(upstream.body);
      expect(body.model).toBe("gpt-3.5-turbo");
    });
  });

  describe("modifyMessages", () => {
    test("replaces messages field in rawBody", () => {
      const rawBody = {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "Original long message" },
          { role: "assistant", content: "Original response" },
        ],
        temperature: 0.7,
      };

      const compressed = [
        { role: "user", content: "Compressed message" },
      ];

      const result = openaiCompletionsAdapter.modifyMessages(
        rawBody,
        compressed,
      );

      expect(result.messages).toEqual(compressed);
      expect(result.temperature).toBe(0.7);
      expect(result.model).toBe("gpt-4o");
    });

    test("preserves all other fields", () => {
      const rawBody = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.5,
        top_p: 0.9,
        frequency_penalty: 0.1,
      };

      const result = openaiCompletionsAdapter.modifyMessages(rawBody, []);

      expect(result.temperature).toBe(0.5);
      expect(result.top_p).toBe(0.9);
      expect(result.frequency_penalty).toBe(0.1);
    });
  });

  describe("multiple system messages", () => {
    test("concatenates multiple system messages", () => {
      const body = {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "First instruction." },
          { role: "system", content: "Second instruction." },
          { role: "user", content: "Hi" },
        ],
      };

      const parsed = openaiCompletionsAdapter.parseRequest(body);

      expect(parsed.system).toBe("First instruction.\nSecond instruction.");
      expect(parsed.messages).toHaveLength(1);
    });
  });
});
