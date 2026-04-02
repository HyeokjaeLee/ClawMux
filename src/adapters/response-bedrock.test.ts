import { describe, expect, it } from "bun:test";
import { BedrockAdapter } from "./bedrock.ts";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";

const adapter = new BedrockAdapter();

describe("BedrockAdapter response methods", () => {
  describe("parseResponse", () => {
    it("parses a standard Bedrock Converse response", () => {
      const body = {
        output: {
          message: {
            role: "assistant",
            content: [{ text: "Hello, world!" }],
          },
        },
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      const result = adapter.parseResponse(body);

      expect(result.content).toBe("Hello, world!");
      expect(result.role).toBe("assistant");
      expect(result.stopReason).toBe("stop");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("maps max_tokens stop reason", () => {
      const body = {
        output: {
          message: {
            role: "assistant",
            content: [{ text: "truncated" }],
          },
        },
        stopReason: "max_tokens",
      };

      const result = adapter.parseResponse(body);
      expect(result.stopReason).toBe("max_tokens");
    });

    it("maps content_filtered stop reason", () => {
      const body = {
        output: {
          message: {
            role: "assistant",
            content: [{ text: "" }],
          },
        },
        stopReason: "content_filtered",
      };

      const result = adapter.parseResponse(body);
      expect(result.stopReason).toBe("content_filter");
    });

    it("handles missing output gracefully", () => {
      const body = {};
      const result = adapter.parseResponse(body);

      expect(result.content).toBe("");
      expect(result.role).toBe("assistant");
      expect(result.stopReason).toBeNull();
    });

    it("joins multiple text content blocks", () => {
      const body = {
        output: {
          message: {
            role: "assistant",
            content: [{ text: "Hello, " }, { text: "world!" }],
          },
        },
        stopReason: "end_turn",
      };

      const result = adapter.parseResponse(body);
      expect(result.content).toBe("Hello, world!");
    });

    it("handles missing usage", () => {
      const body = {
        output: {
          message: {
            role: "assistant",
            content: [{ text: "test" }],
          },
        },
        stopReason: "end_turn",
      };

      const result = adapter.parseResponse(body);
      expect(result.usage).toBeUndefined();
    });

    it("uses requestId as id", () => {
      const body = {
        requestId: "req-abc-123",
        output: {
          message: {
            role: "assistant",
            content: [{ text: "test" }],
          },
        },
        stopReason: "end_turn",
      };

      const result = adapter.parseResponse(body);
      expect(result.id).toBe("req-abc-123");
    });
  });

  describe("buildResponse", () => {
    it("builds a standard Bedrock Converse response", () => {
      const parsed: ParsedResponse = {
        id: "test-id",
        model: "anthropic.claude-3",
        content: "Hello!",
        role: "assistant",
        stopReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      const result = adapter.buildResponse(parsed);

      expect(result.output).toEqual({
        message: {
          role: "assistant",
          content: [{ text: "Hello!" }],
        },
      });
      expect(result.stopReason).toBe("end_turn");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("builds response without usage", () => {
      const parsed: ParsedResponse = {
        id: "test-id",
        model: "anthropic.claude-3",
        content: "Hello!",
        role: "assistant",
        stopReason: "stop",
      };

      const result = adapter.buildResponse(parsed);
      expect(result.usage).toBeUndefined();
    });

    it("maps max_tokens back to max_tokens", () => {
      const parsed: ParsedResponse = {
        id: "test-id",
        model: "anthropic.claude-3",
        content: "truncated",
        role: "assistant",
        stopReason: "max_tokens",
      };

      const result = adapter.buildResponse(parsed);
      expect(result.stopReason).toBe("max_tokens");
    });

    it("maps content_filter back to content_filtered", () => {
      const parsed: ParsedResponse = {
        id: "test-id",
        model: "anthropic.claude-3",
        content: "",
        role: "assistant",
        stopReason: "content_filter",
      };

      const result = adapter.buildResponse(parsed);
      expect(result.stopReason).toBe("content_filtered");
    });
  });

  describe("parseResponse/buildResponse round-trip", () => {
    it("round-trips a response", () => {
      const original = {
        output: {
          message: {
            role: "assistant",
            content: [{ text: "Round trip!" }],
          },
        },
        stopReason: "end_turn",
        usage: { inputTokens: 15, outputTokens: 8 },
      };

      const parsed = adapter.parseResponse(original);
      const rebuilt = adapter.buildResponse(parsed);

      expect(rebuilt.output).toEqual(original.output);
      expect(rebuilt.stopReason).toBe(original.stopReason);
      expect(rebuilt.usage).toEqual(original.usage);
    });
  });

  describe("parseStreamChunk", () => {
    it("parses messageStart event", () => {
      const chunk = JSON.stringify({
        messageStart: { role: "assistant" },
      });

      const events = adapter.parseStreamChunk(chunk);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("message_start");
    });

    it("parses contentBlockDelta event", () => {
      const chunk = JSON.stringify({
        contentBlockDelta: {
          delta: { text: "Hello" },
          contentBlockIndex: 0,
        },
      });

      const events = adapter.parseStreamChunk(chunk);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("content_delta");
      if (events[0].type === "content_delta") {
        expect(events[0].text).toBe("Hello");
        expect(events[0].index).toBe(0);
      }
    });

    it("parses contentBlockStop event", () => {
      const chunk = JSON.stringify({
        contentBlockStop: { contentBlockIndex: 0 },
      });

      const events = adapter.parseStreamChunk(chunk);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("content_stop");
      if (events[0].type === "content_stop") {
        expect(events[0].index).toBe(0);
      }
    });

    it("parses messageStop event", () => {
      const chunk = JSON.stringify({
        messageStop: { stopReason: "end_turn" },
      });

      const events = adapter.parseStreamChunk(chunk);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("message_stop");
    });

    it("parses metadata with usage", () => {
      const chunk = JSON.stringify({
        metadata: {
          usage: { inputTokens: 10, outputTokens: 20 },
        },
      });

      const events = adapter.parseStreamChunk(chunk);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("message_stop");
      if (events[0].type === "message_stop") {
        expect(events[0].usage).toEqual({
          inputTokens: 10,
          outputTokens: 20,
        });
      }
    });

    it("parses multiple events in one chunk", () => {
      const chunk = [
        JSON.stringify({ messageStart: { role: "assistant" } }),
        JSON.stringify({
          contentBlockDelta: {
            delta: { text: "Hi" },
            contentBlockIndex: 0,
          },
        }),
      ].join("\n");

      const events = adapter.parseStreamChunk(chunk);

      expect(events.length).toBe(2);
      expect(events[0].type).toBe("message_start");
      expect(events[1].type).toBe("content_delta");
    });

    it("returns empty array for empty chunk", () => {
      const events = adapter.parseStreamChunk("");
      expect(events).toEqual([]);
    });

    it("skips invalid JSON lines", () => {
      const events = adapter.parseStreamChunk("{invalid json}");
      expect(events).toEqual([]);
    });
  });

  describe("buildStreamChunk", () => {
    it("builds messageStart event", () => {
      const event: StreamEvent = {
        type: "message_start",
        id: "msg_1",
        model: "anthropic.claude-3",
      };

      const chunk = adapter.buildStreamChunk(event);
      const parsed = JSON.parse(chunk.trim());
      expect(parsed.messageStart.role).toBe("assistant");
    });

    it("builds contentBlockDelta event", () => {
      const event: StreamEvent = {
        type: "content_delta",
        text: "Hello",
        index: 0,
      };

      const chunk = adapter.buildStreamChunk(event);
      const parsed = JSON.parse(chunk.trim());
      expect(parsed.contentBlockDelta.delta.text).toBe("Hello");
      expect(parsed.contentBlockDelta.contentBlockIndex).toBe(0);
    });

    it("builds contentBlockStop event", () => {
      const event: StreamEvent = { type: "content_stop", index: 0 };

      const chunk = adapter.buildStreamChunk(event);
      const parsed = JSON.parse(chunk.trim());
      expect(parsed.contentBlockStop.contentBlockIndex).toBe(0);
    });

    it("builds messageStop without usage", () => {
      const event: StreamEvent = { type: "message_stop" };

      const chunk = adapter.buildStreamChunk(event);
      const parsed = JSON.parse(chunk.trim());
      expect(parsed.messageStop.stopReason).toBe("end_turn");
    });

    it("builds messageStop with usage as two lines", () => {
      const event: StreamEvent = {
        type: "message_stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      };

      const chunk = adapter.buildStreamChunk(event);
      const lines = chunk.trim().split("\n");
      expect(lines.length).toBe(2);

      const stopLine = JSON.parse(lines[0]);
      expect(stopLine.messageStop.stopReason).toBe("end_turn");

      const metaLine = JSON.parse(lines[1]);
      expect(metaLine.metadata.usage.inputTokens).toBe(10);
      expect(metaLine.metadata.usage.outputTokens).toBe(20);
    });

    it("builds error event", () => {
      const event: StreamEvent = {
        type: "error",
        message: "something broke",
      };

      const chunk = adapter.buildStreamChunk(event);
      const parsed = JSON.parse(chunk.trim());
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

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("content_delta");
      if (events[0].type === "content_delta") {
        expect(events[0].text).toBe("Hello world");
        expect(events[0].index).toBe(0);
      }
    });

    it("round-trips message_start", () => {
      const original: StreamEvent = {
        type: "message_start",
        id: "msg_1",
        model: "anthropic.claude-3",
      };

      const chunk = adapter.buildStreamChunk(original);
      const events = adapter.parseStreamChunk(chunk);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("message_start");
    });

    it("round-trips content_stop", () => {
      const original: StreamEvent = { type: "content_stop", index: 0 };

      const chunk = adapter.buildStreamChunk(original);
      const events = adapter.parseStreamChunk(chunk);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe("content_stop");
      if (events[0].type === "content_stop") {
        expect(events[0].index).toBe(0);
      }
    });

    it("round-trips message_stop with usage", () => {
      const original: StreamEvent = {
        type: "message_stop",
        usage: { inputTokens: 50, outputTokens: 100 },
      };

      const chunk = adapter.buildStreamChunk(original);
      const events = adapter.parseStreamChunk(chunk);

      const metaEvent = events.find(
        (e) => e.type === "message_stop" && e.usage !== undefined,
      );
      expect(metaEvent).toBeDefined();
      if (metaEvent?.type === "message_stop") {
        expect(metaEvent.usage).toEqual({
          inputTokens: 50,
          outputTokens: 100,
        });
      }
    });
  });
});
