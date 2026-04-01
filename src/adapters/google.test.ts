import { describe, expect, test } from "bun:test";
import { GoogleGenerativeAIAdapter } from "./google.ts";
import type { AuthInfo, ParsedRequest } from "./types.ts";

const adapter = new GoogleGenerativeAIAdapter();

const defaultAuth: AuthInfo = {
  apiKey: "test-api-key",
  headerName: "x-goog-api-key",
  headerValue: "test-api-key",
};

describe("GoogleGenerativeAIAdapter", () => {
  test("apiType is google-generative-ai", () => {
    expect(adapter.apiType).toBe("google-generative-ai");
  });

  describe("parseRequest", () => {
    test("extracts model and converts contents to messages", () => {
      const body = {
        model: "gemini-pro",
        contents: [
          { role: "user", parts: [{ text: "Hello" }] },
          { role: "model", parts: [{ text: "Hi there" }] },
        ],
      };

      const parsed = adapter.parseRequest(body);

      expect(parsed.model).toBe("gemini-pro");
      expect(parsed.messages).toEqual([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ]);
      expect(parsed.stream).toBe(true);
    });

    test("extracts system instruction", () => {
      const body = {
        model: "gemini-pro",
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        systemInstruction: { parts: [{ text: "You are helpful" }] },
      };

      const parsed = adapter.parseRequest(body);
      expect(parsed.system).toBe("You are helpful");
    });

    test("extracts maxTokens from generationConfig", () => {
      const body = {
        model: "gemini-pro",
        contents: [],
        generationConfig: { maxOutputTokens: 1024 },
      };

      const parsed = adapter.parseRequest(body);
      expect(parsed.maxTokens).toBe(1024);
    });

    test("handles missing contents gracefully", () => {
      const body = { model: "gemini-pro" };
      const parsed = adapter.parseRequest(body);
      expect(parsed.messages).toEqual([]);
    });

    test("defaults stream to true", () => {
      const body = { model: "gemini-pro", contents: [] };
      const parsed = adapter.parseRequest(body);
      expect(parsed.stream).toBe(true);
    });

    test("respects stream: false", () => {
      const body = { model: "gemini-pro", contents: [], stream: false };
      const parsed = adapter.parseRequest(body);
      expect(parsed.stream).toBe(false);
    });

    test("handles content with no role (defaults to user)", () => {
      const body = {
        model: "gemini-pro",
        contents: [{ parts: [{ text: "Hello" }] }],
      };

      const parsed = adapter.parseRequest(body);
      expect(parsed.messages[0].role).toBe("user");
    });
  });

  describe("buildUpstreamRequest", () => {
    const baseParsed: ParsedRequest = {
      model: "gemini-pro",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      rawBody: {},
    };

    test("builds streaming URL with alt=sse", () => {
      const result = adapter.buildUpstreamRequest(
        baseParsed,
        "gemini-1.5-pro",
        "https://generativelanguage.googleapis.com",
        defaultAuth,
      );

      expect(result.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:streamGenerateContent?alt=sse",
      );
      expect(result.method).toBe("POST");
    });

    test("builds non-streaming URL", () => {
      const nonStreamParsed = { ...baseParsed, stream: false };
      const result = adapter.buildUpstreamRequest(
        nonStreamParsed,
        "gemini-1.5-pro",
        "https://generativelanguage.googleapis.com",
        defaultAuth,
      );

      expect(result.url).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent",
      );
    });

    test("sets x-goog-api-key header", () => {
      const result = adapter.buildUpstreamRequest(
        baseParsed,
        "gemini-pro",
        "https://generativelanguage.googleapis.com",
        defaultAuth,
      );

      expect(result.headers["x-goog-api-key"]).toBe("test-api-key");
    });

    test("converts messages to Google contents format in body", () => {
      const result = adapter.buildUpstreamRequest(
        baseParsed,
        "gemini-pro",
        "https://generativelanguage.googleapis.com",
        defaultAuth,
      );

      const body = JSON.parse(result.body);
      expect(body.contents).toEqual([
        { role: "user", parts: [{ text: "Hello" }] },
      ]);
      expect(body.model).toBeUndefined();
    });

    test("includes system instruction in body", () => {
      const withSystem = { ...baseParsed, system: "Be helpful" };
      const result = adapter.buildUpstreamRequest(
        withSystem,
        "gemini-pro",
        "https://generativelanguage.googleapis.com",
        defaultAuth,
      );

      const body = JSON.parse(result.body);
      expect(body.systemInstruction).toEqual({
        parts: [{ text: "Be helpful" }],
      });
    });

    test("includes maxTokens in generationConfig", () => {
      const withTokens = { ...baseParsed, maxTokens: 2048 };
      const result = adapter.buildUpstreamRequest(
        withTokens,
        "gemini-pro",
        "https://generativelanguage.googleapis.com",
        defaultAuth,
      );

      const body = JSON.parse(result.body);
      expect(body.generationConfig.maxOutputTokens).toBe(2048);
    });
  });

  describe("modifyMessages", () => {
    test("replaces contents field with converted messages", () => {
      const rawBody = {
        model: "gemini-pro",
        contents: [{ role: "user", parts: [{ text: "old" }] }],
        generationConfig: { temperature: 0.7 },
      };

      const newMessages = [
        { role: "user", content: "compressed" },
        { role: "assistant", content: "response" },
      ];

      const result = adapter.modifyMessages(rawBody, newMessages);

      expect(result.contents).toEqual([
        { role: "user", parts: [{ text: "compressed" }] },
        { role: "model", parts: [{ text: "response" }] },
      ]);
      expect(result.generationConfig).toEqual({ temperature: 0.7 });
    });

    test("preserves other fields", () => {
      const rawBody = {
        generationConfig: { temperature: 0.5 },
        safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT" }],
      };

      const result = adapter.modifyMessages(rawBody, []);
      expect(result.generationConfig).toEqual({ temperature: 0.5 });
      expect(result.safetySettings).toEqual([
        { category: "HARM_CATEGORY_HARASSMENT" },
      ]);
    });
  });
});
