import { describe, expect, test } from "bun:test";
import { openaiResponsesAdapter } from "./openai-responses.ts";
import { getAdapter } from "./registry.ts";

const AUTH = {
  apiKey: "sk-test-key",
  headerName: "Authorization",
  headerValue: "Bearer sk-test-key",
};

describe("OpenAIResponsesAdapter", () => {
  test("apiType is openai-responses", () => {
    expect(openaiResponsesAdapter.apiType).toBe("openai-responses");
  });

  test("is registered in adapter registry", () => {
    const adapter = getAdapter("openai-responses");
    expect(adapter).toBe(openaiResponsesAdapter);
  });

  describe("parseRequest", () => {
    test("parses body with messages field", () => {
      const body = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      };

      const parsed = openaiResponsesAdapter.parseRequest(body);

      expect(parsed.model).toBe("gpt-4o");
      expect(parsed.messages).toEqual([{ role: "user", content: "Hello" }]);
      expect(parsed.stream).toBe(false);
    });

    test("parses body with input field (Responses API format)", () => {
      const body = {
        model: "gpt-4o",
        input: [{ role: "user", content: "Hello from input" }],
      };

      const parsed = openaiResponsesAdapter.parseRequest(body);

      expect(parsed.model).toBe("gpt-4o");
      expect(parsed.messages).toEqual([
        { role: "user", content: "Hello from input" },
      ]);
    });

    test("extracts system message from input array", () => {
      const body = {
        model: "gpt-4o",
        input: [
          { role: "system", content: "You are a poet." },
          { role: "user", content: "Write a haiku" },
        ],
      };

      const parsed = openaiResponsesAdapter.parseRequest(body);

      expect(parsed.system).toBe("You are a poet.");
      expect(parsed.messages).toEqual([
        { role: "user", content: "Write a haiku" },
      ]);
    });

    test("extracts developer role as system message", () => {
      const body = {
        model: "gpt-4o",
        input: [
          { role: "developer", content: "Be brief." },
          { role: "user", content: "Hi" },
        ],
      };

      const parsed = openaiResponsesAdapter.parseRequest(body);

      expect(parsed.system).toBe("Be brief.");
    });

    test("parses max_output_tokens", () => {
      const body = {
        model: "gpt-4o",
        input: [{ role: "user", content: "Hi" }],
        max_output_tokens: 2048,
      };

      const parsed = openaiResponsesAdapter.parseRequest(body);

      expect(parsed.maxTokens).toBe(2048);
    });

    test("parses stream: true", () => {
      const body = {
        model: "gpt-4o",
        input: [{ role: "user", content: "Hi" }],
        stream: true,
      };

      const parsed = openaiResponsesAdapter.parseRequest(body);

      expect(parsed.stream).toBe(true);
    });

    test("preserves rawBody with all original fields", () => {
      const body = {
        model: "gpt-4o",
        input: [{ role: "user", content: "Hi" }],
        temperature: 0.8,
        instructions: "Be helpful",
      };

      const parsed = openaiResponsesAdapter.parseRequest(body);

      expect(parsed.rawBody.temperature).toBe(0.8);
      expect(parsed.rawBody.instructions).toBe("Be helpful");
    });

    test("throws on missing model", () => {
      const body = {
        input: [{ role: "user", content: "Hi" }],
      };

      expect(() => openaiResponsesAdapter.parseRequest(body)).toThrow(
        "Missing required field: model",
      );
    });

    test("throws on missing messages and input", () => {
      const body = { model: "gpt-4o" };

      expect(() => openaiResponsesAdapter.parseRequest(body)).toThrow(
        "Request must contain a valid 'messages' or 'input' array",
      );
    });

    test("throws on invalid body type", () => {
      expect(() => openaiResponsesAdapter.parseRequest(null)).toThrow(
        "Request body must be a JSON object",
      );
    });
  });

  describe("buildUpstreamRequest", () => {
    test("builds correct upstream request to /v1/responses", () => {
      const parsed = openaiResponsesAdapter.parseRequest({
        model: "gpt-4o",
        input: [{ role: "user", content: "Hello" }],
        temperature: 0.5,
      });

      const upstream = openaiResponsesAdapter.buildUpstreamRequest(
        parsed,
        "gpt-4o-mini",
        "https://api.openai.com",
        AUTH,
      );

      expect(upstream.url).toBe("https://api.openai.com/v1/responses");
      expect(upstream.method).toBe("POST");
      expect(upstream.headers["Authorization"]).toBe("Bearer sk-test-key");
      expect(upstream.headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(upstream.body);
      expect(body.model).toBe("gpt-4o-mini");
      expect(body.temperature).toBe(0.5);
    });

    test("overrides model in upstream body", () => {
      const parsed = openaiResponsesAdapter.parseRequest({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      });

      const upstream = openaiResponsesAdapter.buildUpstreamRequest(
        parsed,
        "o1-preview",
        "https://custom.api.com",
        AUTH,
      );

      const body = JSON.parse(upstream.body);
      expect(body.model).toBe("o1-preview");
    });
  });

  describe("modifyMessages", () => {
    test("replaces input field when original body uses input", () => {
      const rawBody = {
        model: "gpt-4o",
        input: [
          { role: "user", content: "Original long message" },
          { role: "assistant", content: "Original response" },
        ],
        temperature: 0.7,
      };

      const compressed = [{ role: "user", content: "Compressed" }];

      const result = openaiResponsesAdapter.modifyMessages(
        rawBody,
        compressed,
      );

      expect(result.input).toEqual(compressed);
      expect(result.temperature).toBe(0.7);
      expect(result.model).toBe("gpt-4o");
    });

    test("replaces messages field when original body uses messages", () => {
      const rawBody = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Original" }],
      };

      const compressed = [{ role: "user", content: "Compressed" }];

      const result = openaiResponsesAdapter.modifyMessages(
        rawBody,
        compressed,
      );

      expect(result.messages).toEqual(compressed);
    });

    test("preserves all other fields", () => {
      const rawBody = {
        model: "gpt-4o",
        input: [{ role: "user", content: "Hi" }],
        temperature: 0.5,
        instructions: "Be helpful",
        max_output_tokens: 1024,
      };

      const result = openaiResponsesAdapter.modifyMessages(rawBody, []);

      expect(result.temperature).toBe(0.5);
      expect(result.instructions).toBe("Be helpful");
      expect(result.max_output_tokens).toBe(1024);
    });
  });

  describe("content array format", () => {
    test("handles system message with content array", () => {
      const body = {
        model: "gpt-4o",
        input: [
          {
            role: "system",
            content: [
              { type: "text", text: "First part" },
              { type: "text", text: "Second part" },
            ],
          },
          { role: "user", content: "Hi" },
        ],
      };

      const parsed = openaiResponsesAdapter.parseRequest(body);

      expect(parsed.system).toBe("First part\nSecond part");
      expect(parsed.messages).toHaveLength(1);
    });
  });
});
