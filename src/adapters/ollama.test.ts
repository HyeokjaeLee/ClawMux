import { describe, expect, test } from "bun:test";
import { OllamaAdapter } from "./ollama.ts";
import type { AuthInfo, ParsedRequest } from "./types.ts";

const adapter = new OllamaAdapter();

const dummyAuth: AuthInfo = {
  apiKey: "",
  headerName: "",
  headerValue: "",
};

describe("OllamaAdapter", () => {
  test("apiType is ollama", () => {
    expect(adapter.apiType).toBe("ollama");
  });

  describe("parseRequest", () => {
    test("extracts model and messages", () => {
      const body = {
        model: "llama3",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
        ],
      };

      const parsed = adapter.parseRequest(body);

      expect(parsed.model).toBe("llama3");
      expect(parsed.messages).toEqual([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ]);
      expect(parsed.stream).toBe(true);
    });

    test("extracts system message from messages array", () => {
      const body = {
        model: "llama3",
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello" },
        ],
      };

      const parsed = adapter.parseRequest(body);
      expect(parsed.system).toBe("You are helpful");
      expect(parsed.messages).toEqual([
        { role: "user", content: "Hello" },
      ]);
    });

    test("extracts num_predict as maxTokens", () => {
      const body = {
        model: "llama3",
        messages: [],
        options: { num_predict: 512 },
      };

      const parsed = adapter.parseRequest(body);
      expect(parsed.maxTokens).toBe(512);
    });

    test("defaults stream to true", () => {
      const body = { model: "llama3", messages: [] };
      const parsed = adapter.parseRequest(body);
      expect(parsed.stream).toBe(true);
    });

    test("respects stream: false", () => {
      const body = { model: "llama3", messages: [], stream: false };
      const parsed = adapter.parseRequest(body);
      expect(parsed.stream).toBe(false);
    });

    test("handles missing messages", () => {
      const body = { model: "llama3" };
      const parsed = adapter.parseRequest(body);
      expect(parsed.messages).toEqual([]);
    });
  });

  describe("buildUpstreamRequest", () => {
    const baseParsed: ParsedRequest = {
      model: "llama3",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      rawBody: {},
    };

    test("builds correct URL", () => {
      const result = adapter.buildUpstreamRequest(
        baseParsed,
        "llama3:70b",
        "http://localhost:11434",
        dummyAuth,
      );

      expect(result.url).toBe("http://localhost:11434/api/chat");
      expect(result.method).toBe("POST");
    });

    test("does not include auth headers", () => {
      const result = adapter.buildUpstreamRequest(
        baseParsed,
        "llama3",
        "http://localhost:11434",
        dummyAuth,
      );

      expect(result.headers).toEqual({
        "Content-Type": "application/json",
      });
    });

    test("includes model, messages, and stream in body", () => {
      const result = adapter.buildUpstreamRequest(
        baseParsed,
        "llama3:70b",
        "http://localhost:11434",
        dummyAuth,
      );

      const body = JSON.parse(result.body);
      expect(body.model).toBe("llama3:70b");
      expect(body.stream).toBe(true);
      expect(body.messages).toEqual([
        { role: "user", content: "Hello" },
      ]);
    });

    test("prepends system message when present", () => {
      const withSystem = { ...baseParsed, system: "Be concise" };
      const result = adapter.buildUpstreamRequest(
        withSystem,
        "llama3",
        "http://localhost:11434",
        dummyAuth,
      );

      const body = JSON.parse(result.body);
      expect(body.messages[0]).toEqual({
        role: "system",
        content: "Be concise",
      });
      expect(body.messages[1]).toEqual({
        role: "user",
        content: "Hello",
      });
    });

    test("includes num_predict in options when maxTokens set", () => {
      const withTokens = { ...baseParsed, maxTokens: 256 };
      const result = adapter.buildUpstreamRequest(
        withTokens,
        "llama3",
        "http://localhost:11434",
        dummyAuth,
      );

      const body = JSON.parse(result.body);
      expect(body.options.num_predict).toBe(256);
    });
  });

  describe("modifyMessages", () => {
    test("replaces messages field", () => {
      const rawBody = {
        model: "llama3",
        messages: [{ role: "user", content: "old" }],
        stream: true,
      };

      const newMessages = [
        { role: "user", content: "compressed" },
        { role: "assistant", content: "response" },
      ];

      const result = adapter.modifyMessages(rawBody, newMessages);

      expect(result.messages).toEqual(newMessages);
      expect(result.model).toBe("llama3");
      expect(result.stream).toBe(true);
    });

    test("preserves other fields", () => {
      const rawBody = {
        model: "llama3",
        messages: [],
        options: { temperature: 0.8 },
      };

      const result = adapter.modifyMessages(rawBody, []);
      expect(result.options).toEqual({ temperature: 0.8 });
    });
  });
});
