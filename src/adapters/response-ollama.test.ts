import { describe, expect, it } from "bun:test";
import { OllamaAdapter } from "./ollama.ts";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";

const adapter = new OllamaAdapter();

describe("OllamaAdapter response methods", () => {
  describe("parseResponse", () => {
    it("parses a standard Ollama response", () => {
      const body = {
        model: "llama3",
        message: { role: "assistant", content: "Hello, world!" },
        done: true,
        prompt_eval_count: 10,
        eval_count: 5,
      };

      const result = adapter.parseResponse(body);

      expect(result.content).toBe("Hello, world!");
      expect(result.model).toBe("llama3");
      expect(result.role).toBe("assistant");
      expect(result.stopReason).toBe("stop");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("handles done=false as null stopReason", () => {
      const body = {
        model: "llama3",
        message: { role: "assistant", content: "partial" },
        done: false,
      };

      const result = adapter.parseResponse(body);
      expect(result.stopReason).toBeNull();
    });

    it("handles missing message gracefully", () => {
      const body = { model: "llama3", done: true };
      const result = adapter.parseResponse(body);

      expect(result.content).toBe("");
      expect(result.model).toBe("llama3");
    });

    it("handles missing usage counts", () => {
      const body = {
        model: "llama3",
        message: { role: "assistant", content: "test" },
        done: true,
      };

      const result = adapter.parseResponse(body);
      expect(result.usage).toBeUndefined();
    });

    it("handles zero usage counts", () => {
      const body = {
        model: "llama3",
        message: { role: "assistant", content: "test" },
        done: true,
        prompt_eval_count: 0,
        eval_count: 0,
      };

      const result = adapter.parseResponse(body);
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });
  });

  describe("buildResponse", () => {
    it("builds a standard Ollama response", () => {
      const parsed: ParsedResponse = {
        id: "test-id",
        model: "llama3",
        content: "Hello!",
        role: "assistant",
        stopReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      const result = adapter.buildResponse(parsed);

      expect(result.model).toBe("llama3");
      expect(result.message).toEqual({
        role: "assistant",
        content: "Hello!",
      });
      expect(result.done).toBe(true);
      expect(result.prompt_eval_count).toBe(10);
      expect(result.eval_count).toBe(5);
    });

    it("builds response with done=false for non-stop reason", () => {
      const parsed: ParsedResponse = {
        id: "test-id",
        model: "llama3",
        content: "truncated",
        role: "assistant",
        stopReason: "max_tokens",
      };

      const result = adapter.buildResponse(parsed);
      expect(result.done).toBe(false);
    });

    it("builds response without usage", () => {
      const parsed: ParsedResponse = {
        id: "test-id",
        model: "llama3",
        content: "Hello!",
        role: "assistant",
        stopReason: "stop",
      };

      const result = adapter.buildResponse(parsed);
      expect(result.prompt_eval_count).toBeUndefined();
      expect(result.eval_count).toBeUndefined();
    });
  });

  describe("parseResponse/buildResponse round-trip", () => {
    it("round-trips a response", () => {
      const original = {
        model: "llama3",
        message: { role: "assistant", content: "Round trip!" },
        done: true,
        prompt_eval_count: 15,
        eval_count: 8,
      };

      const parsed = adapter.parseResponse(original);
      const rebuilt = adapter.buildResponse(parsed);

      expect(rebuilt.model).toBe(original.model);
      expect(rebuilt.message).toEqual(original.message);
      expect(rebuilt.done).toBe(original.done);
      expect(rebuilt.prompt_eval_count).toBe(original.prompt_eval_count);
      expect(rebuilt.eval_count).toBe(original.eval_count);
    });
  });

  describe("parseStreamChunk", () => {
    it("parses first NDJSON chunk as message_start + content_delta", () => {
      const chunk = JSON.stringify({
        model: "llama3",
        message: { role: "assistant", content: "Hello" },
        done: false,
      });

      const events = adapter.parseStreamChunk(chunk);

      expect(events.length).toBe(2);
      expect(events[0].type).toBe("message_start");
      if (events[0].type === "message_start") {
        expect(events[0].model).toBe("llama3");
      }
      expect(events[1].type).toBe("content_delta");
      if (events[1].type === "content_delta") {
        expect(events[1].text).toBe("Hello");
      }
    });

    it("parses done=true as content_stop + message_stop", () => {
      const chunk = JSON.stringify({
        model: "llama3",
        done: true,
        prompt_eval_count: 10,
        eval_count: 20,
      });

      const events = adapter.parseStreamChunk(chunk);

      expect(events.some((e) => e.type === "content_stop")).toBe(true);
      const messageStop = events.find((e) => e.type === "message_stop");
      expect(messageStop).toBeDefined();
      if (messageStop?.type === "message_stop") {
        expect(messageStop.usage).toEqual({
          inputTokens: 10,
          outputTokens: 20,
        });
      }
    });

    it("parses multiple NDJSON lines", () => {
      const chunk = [
        JSON.stringify({
          model: "llama3",
          message: { role: "assistant", content: "Hi" },
          done: false,
        }),
        JSON.stringify({
          model: "llama3",
          message: { role: "assistant", content: " there" },
          done: false,
        }),
      ].join("\n");

      const events = adapter.parseStreamChunk(chunk);

      const deltas = events.filter((e) => e.type === "content_delta");
      expect(deltas.length).toBe(2);
    });

    it("returns empty array for empty chunk", () => {
      const events = adapter.parseStreamChunk("");
      expect(events).toEqual([]);
    });

    it("skips invalid JSON lines", () => {
      const events = adapter.parseStreamChunk("{invalid json}");
      expect(events).toEqual([]);
    });

    it("handles done=true without usage", () => {
      const chunk = JSON.stringify({ done: true });
      const events = adapter.parseStreamChunk(chunk);

      const messageStop = events.find((e) => e.type === "message_stop");
      expect(messageStop).toBeDefined();
      if (messageStop?.type === "message_stop") {
        expect(messageStop.usage).toBeUndefined();
      }
    });
  });

  describe("buildStreamChunk", () => {
    it("builds message_start as NDJSON", () => {
      const event: StreamEvent = {
        type: "message_start",
        id: "msg_1",
        model: "llama3",
      };

      const chunk = adapter.buildStreamChunk(event);
      expect(chunk.endsWith("\n")).toBe(true);
      expect(chunk.startsWith("data:")).toBe(false);

      const parsed = JSON.parse(chunk);
      expect(parsed.model).toBe("llama3");
      expect(parsed.message.role).toBe("assistant");
      expect(parsed.done).toBe(false);
    });

    it("builds content_delta as NDJSON", () => {
      const event: StreamEvent = {
        type: "content_delta",
        text: "Hello",
        index: 0,
      };

      const chunk = adapter.buildStreamChunk(event);
      const parsed = JSON.parse(chunk);
      expect(parsed.message.content).toBe("Hello");
      expect(parsed.done).toBe(false);
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
      const parsed = JSON.parse(chunk);
      expect(parsed.done).toBe(true);
      expect(parsed.prompt_eval_count).toBe(10);
      expect(parsed.eval_count).toBe(20);
    });

    it("builds message_stop without usage", () => {
      const event: StreamEvent = { type: "message_stop" };

      const chunk = adapter.buildStreamChunk(event);
      const parsed = JSON.parse(chunk);
      expect(parsed.done).toBe(true);
      expect(parsed.prompt_eval_count).toBeUndefined();
    });

    it("builds error chunk", () => {
      const event: StreamEvent = {
        type: "error",
        message: "something broke",
      };

      const chunk = adapter.buildStreamChunk(event);
      const parsed = JSON.parse(chunk);
      expect(parsed.error).toBe("something broke");
      expect(parsed.done).toBe(true);
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
