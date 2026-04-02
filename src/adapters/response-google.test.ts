import { describe, expect, it } from "bun:test";
import { GoogleGenerativeAIAdapter } from "./google.ts";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";

const adapter = new GoogleGenerativeAIAdapter();

describe("GoogleGenerativeAIAdapter response methods", () => {
  describe("parseResponse", () => {
    it("parses a standard Google response", () => {
      const body = {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello, world!" }],
              role: "model",
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
        },
      };

      const result = adapter.parseResponse(body);

      expect(result.content).toBe("Hello, world!");
      expect(result.role).toBe("assistant");
      expect(result.stopReason).toBe("stop");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("maps MAX_TOKENS finish reason", () => {
      const body = {
        candidates: [
          {
            content: { parts: [{ text: "truncated" }], role: "model" },
            finishReason: "MAX_TOKENS",
          },
        ],
      };

      const result = adapter.parseResponse(body);
      expect(result.stopReason).toBe("max_tokens");
    });

    it("maps SAFETY finish reason", () => {
      const body = {
        candidates: [
          {
            content: { parts: [{ text: "" }], role: "model" },
            finishReason: "SAFETY",
          },
        ],
      };

      const result = adapter.parseResponse(body);
      expect(result.stopReason).toBe("content_filter");
    });

    it("handles missing candidates gracefully", () => {
      const body = {};
      const result = adapter.parseResponse(body);

      expect(result.content).toBe("");
      expect(result.role).toBe("assistant");
      expect(result.stopReason).toBeNull();
    });

    it("joins multiple text parts", () => {
      const body = {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello, " }, { text: "world!" }],
              role: "model",
            },
            finishReason: "STOP",
          },
        ],
      };

      const result = adapter.parseResponse(body);
      expect(result.content).toBe("Hello, world!");
    });

    it("handles missing usage metadata", () => {
      const body = {
        candidates: [
          {
            content: { parts: [{ text: "test" }], role: "model" },
            finishReason: "STOP",
          },
        ],
      };

      const result = adapter.parseResponse(body);
      expect(result.usage).toBeUndefined();
    });
  });

  describe("buildResponse", () => {
    it("builds a standard Google response", () => {
      const parsed: ParsedResponse = {
        id: "test-id",
        model: "gemini-pro",
        content: "Hello!",
        role: "assistant",
        stopReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      const result = adapter.buildResponse(parsed);

      expect(result.candidates).toEqual([
        {
          content: { parts: [{ text: "Hello!" }], role: "model" },
          finishReason: "STOP",
        },
      ]);
      expect(result.usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 5,
      });
    });

    it("builds response without usage", () => {
      const parsed: ParsedResponse = {
        id: "test-id",
        model: "gemini-pro",
        content: "Hello!",
        role: "assistant",
        stopReason: "stop",
      };

      const result = adapter.buildResponse(parsed);
      expect(result.usageMetadata).toBeUndefined();
    });

    it("maps max_tokens back to MAX_TOKENS", () => {
      const parsed: ParsedResponse = {
        id: "test-id",
        model: "gemini-pro",
        content: "truncated",
        role: "assistant",
        stopReason: "max_tokens",
      };

      const result = adapter.buildResponse(parsed);
      const candidates = result.candidates as Array<Record<string, unknown>>;
      expect(candidates[0].finishReason).toBe("MAX_TOKENS");
    });
  });

  describe("parseResponse/buildResponse round-trip", () => {
    it("round-trips a response", () => {
      const original = {
        candidates: [
          {
            content: { parts: [{ text: "Round trip!" }], role: "model" },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 15,
          candidatesTokenCount: 8,
        },
      };

      const parsed = adapter.parseResponse(original);
      const rebuilt = adapter.buildResponse(parsed);

      expect(rebuilt.candidates).toEqual(original.candidates);
      expect(rebuilt.usageMetadata).toEqual(original.usageMetadata);
    });
  });

  describe("parseStreamChunk", () => {
    it("parses first chunk with role as message_start + content_delta", () => {
      const chunk = `data: ${JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: "Hello" }], role: "model" },
          },
        ],
      })}`;

      const events = adapter.parseStreamChunk(chunk);

      expect(events.length).toBe(2);
      expect(events[0].type).toBe("message_start");
      expect(events[1].type).toBe("content_delta");
      if (events[1].type === "content_delta") {
        expect(events[1].text).toBe("Hello");
      }
    });

    it("parses subsequent chunk as content_delta only", () => {
      const chunk = `data: ${JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: " world" }] },
          },
        ],
      })}`;

      const events = adapter.parseStreamChunk(chunk);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("content_delta");
      if (events[0].type === "content_delta") {
        expect(events[0].text).toBe(" world");
      }
    });

    it("parses finish chunk as content_stop + message_stop", () => {
      const chunk = `data: ${JSON.stringify({
        candidates: [
          {
            content: { parts: [{ text: "" }], role: "model" },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
        },
      })}`;

      const events = adapter.parseStreamChunk(chunk);

      const stopEvents = events.filter(
        (e) => e.type === "content_stop" || e.type === "message_stop",
      );
      expect(stopEvents.length).toBe(2);

      const messageStop = events.find((e) => e.type === "message_stop");
      if (messageStop?.type === "message_stop") {
        expect(messageStop.usage).toEqual({
          inputTokens: 10,
          outputTokens: 20,
        });
      }
    });

    it("returns empty array for empty chunk", () => {
      const events = adapter.parseStreamChunk("");
      expect(events).toEqual([]);
    });

    it("skips invalid JSON", () => {
      const events = adapter.parseStreamChunk("data: {invalid json}");
      expect(events).toEqual([]);
    });

    it("handles [DONE] marker", () => {
      const events = adapter.parseStreamChunk("data: [DONE]");
      expect(events).toEqual([]);
    });
  });

  describe("buildStreamChunk", () => {
    it("builds message_start chunk", () => {
      const event: StreamEvent = {
        type: "message_start",
        id: "msg_1",
        model: "gemini-pro",
      };

      const chunk = adapter.buildStreamChunk(event);
      expect(chunk).toContain("data:");
      expect(chunk).toContain('"role":"model"');
      expect(chunk.endsWith("\n\n")).toBe(true);
    });

    it("builds content_delta chunk", () => {
      const event: StreamEvent = {
        type: "content_delta",
        text: "Hello",
        index: 0,
      };

      const chunk = adapter.buildStreamChunk(event);
      const parsed = JSON.parse(chunk.replace("data: ", "").trim());
      expect(parsed.candidates[0].content.parts[0].text).toBe("Hello");
    });

    it("builds content_stop as empty string", () => {
      const event: StreamEvent = { type: "content_stop", index: 0 };
      expect(adapter.buildStreamChunk(event)).toBe("");
    });

    it("builds message_stop with usage", () => {
      const event: StreamEvent = {
        type: "message_stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      };

      const chunk = adapter.buildStreamChunk(event);
      const parsed = JSON.parse(chunk.replace("data: ", "").trim());
      expect(parsed.candidates[0].finishReason).toBe("STOP");
      expect(parsed.usageMetadata.promptTokenCount).toBe(10);
      expect(parsed.usageMetadata.candidatesTokenCount).toBe(20);
    });

    it("builds error chunk", () => {
      const event: StreamEvent = {
        type: "error",
        message: "something broke",
      };

      const chunk = adapter.buildStreamChunk(event);
      const parsed = JSON.parse(chunk.replace("data: ", "").trim());
      expect(parsed.error.message).toBe("something broke");
    });
  });

  describe("parseStreamChunk/buildStreamChunk round-trip", () => {
    it("round-trips content_delta", () => {
      const original: StreamEvent = {
        type: "content_delta",
        text: "Hello world",
        index: 0,
      };

      const chunk = adapter.buildStreamChunk(original);
      const events = adapter.parseStreamChunk(chunk);

      const delta = events.find((e) => e.type === "content_delta");
      expect(delta).toBeDefined();
      if (delta?.type === "content_delta") {
        expect(delta.text).toBe("Hello world");
      }
    });

    it("round-trips message_stop with usage", () => {
      const original: StreamEvent = {
        type: "message_stop",
        usage: { inputTokens: 50, outputTokens: 100 },
      };

      const chunk = adapter.buildStreamChunk(original);
      const events = adapter.parseStreamChunk(chunk);

      const stop = events.find((e) => e.type === "message_stop");
      expect(stop).toBeDefined();
      if (stop?.type === "message_stop") {
        expect(stop.usage).toEqual({ inputTokens: 50, outputTokens: 100 });
      }
    });
  });
});
