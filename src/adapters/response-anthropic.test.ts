import { describe, expect, it } from "bun:test";
import { AnthropicAdapter } from "./anthropic.ts";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";

const adapter = new AnthropicAdapter();

describe("AnthropicAdapter response methods", () => {
  describe("parseResponse", () => {
    it("parses a valid Anthropic response body", () => {
      const body = {
        id: "msg_01XFDUDYJgAACzvnptvVoYEL",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Hello, world!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const result = adapter.parseResponse(body);

      expect(result.id).toBe("msg_01XFDUDYJgAACzvnptvVoYEL");
      expect(result.model).toBe("claude-sonnet-4-20250514");
      expect(result.content).toBe("Hello, world!");
      expect(result.role).toBe("assistant");
      expect(result.stopReason).toBe("end_turn");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("concatenates multiple text content blocks", () => {
      const body = {
        id: "msg_123",
        model: "claude-sonnet-4-20250514",
        content: [
          { type: "text", text: "Part one. " },
          { type: "text", text: "Part two." },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 8 },
      };

      const result = adapter.parseResponse(body);
      expect(result.content).toBe("Part one. Part two.");
    });

    it("handles null stop_reason", () => {
      const body = {
        id: "msg_456",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "Partial" }],
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 1 },
      };

      const result = adapter.parseResponse(body);
      expect(result.stopReason).toBeNull();
    });

    it("handles missing usage", () => {
      const body = {
        id: "msg_789",
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: "No usage" }],
        stop_reason: "end_turn",
      };

      const result = adapter.parseResponse(body);
      expect(result.usage).toBeUndefined();
    });

    it("skips non-text content blocks", () => {
      const body = {
        id: "msg_abc",
        model: "claude-sonnet-4-20250514",
        content: [
          { type: "tool_use", id: "tool_1", name: "calc", input: {} },
          { type: "text", text: "Only this." },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
      };

      const result = adapter.parseResponse(body);
      expect(result.content).toBe("Only this.");
    });
  });

  describe("buildResponse", () => {
    it("builds a valid Anthropic response from ParsedResponse", () => {
      const parsed: ParsedResponse = {
        id: "msg_01XFDUDYJgAACzvnptvVoYEL",
        model: "claude-sonnet-4-20250514",
        content: "Hello, world!",
        role: "assistant",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      const result = adapter.buildResponse(parsed);

      expect(result.id).toBe("msg_01XFDUDYJgAACzvnptvVoYEL");
      expect(result.type).toBe("message");
      expect(result.role).toBe("assistant");
      expect(result.model).toBe("claude-sonnet-4-20250514");
      expect(result.content).toEqual([
        { type: "text", text: "Hello, world!" },
      ]);
      expect(result.stop_reason).toBe("end_turn");

      const usage = result.usage as Record<string, number>;
      expect(usage.input_tokens).toBe(10);
      expect(usage.output_tokens).toBe(5);
    });

    it("omits usage when not present", () => {
      const parsed: ParsedResponse = {
        id: "msg_no_usage",
        model: "claude-sonnet-4-20250514",
        content: "No usage",
        role: "assistant",
        stopReason: "end_turn",
      };

      const result = adapter.buildResponse(parsed);
      expect(result.usage).toBeUndefined();
    });
  });

  describe("round-trip: parseResponse ↔ buildResponse", () => {
    it("preserves data through build → parse cycle", () => {
      const original: ParsedResponse = {
        id: "msg_roundtrip",
        model: "claude-sonnet-4-20250514",
        content: "Round trip test",
        role: "assistant",
        stopReason: "end_turn",
        usage: { inputTokens: 15, outputTokens: 8 },
      };

      const built = adapter.buildResponse(original);
      const parsed = adapter.parseResponse(built);

      expect(parsed.id).toBe(original.id);
      expect(parsed.model).toBe(original.model);
      expect(parsed.content).toBe(original.content);
      expect(parsed.role).toBe(original.role);
      expect(parsed.stopReason).toBe(original.stopReason);
      expect(parsed.usage).toEqual(original.usage);
    });
  });

  describe("parseStreamChunk", () => {
    it("parses message_start event", () => {
      const chunk =
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-20250514"}}';

      const events = adapter.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("message_start");
      if (events[0].type === "message_start") {
        expect(events[0].id).toBe("msg_1");
        expect(events[0].model).toBe("claude-sonnet-4-20250514");
      }
    });

    it("parses content_block_delta with text_delta", () => {
      const chunk =
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}';

      const events = adapter.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("content_delta");
      if (events[0].type === "content_delta") {
        expect(events[0].text).toBe("Hello");
        expect(events[0].index).toBe(0);
      }
    });

    it("parses content_block_stop", () => {
      const chunk =
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}';

      const events = adapter.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("content_stop");
      if (events[0].type === "content_stop") {
        expect(events[0].index).toBe(0);
      }
    });

    it("parses message_stop event", () => {
      const chunk =
        'event: message_stop\ndata: {"type":"message_stop"}';

      const events = adapter.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("message_stop");
    });

    it("parses message_delta with usage", () => {
      const chunk =
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":25,"output_tokens":10}}';

      const events = adapter.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("message_stop");
      if (events[0].type === "message_stop") {
        expect(events[0].usage).toEqual({
          inputTokens: 25,
          outputTokens: 10,
        });
      }
    });

    it("ignores ping events", () => {
      const chunk = 'event: ping\ndata: {"type":"ping"}';
      const events = adapter.parseStreamChunk(chunk);
      expect(events).toHaveLength(0);
    });

    it("ignores content_block_start events", () => {
      const chunk =
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}';
      const events = adapter.parseStreamChunk(chunk);
      expect(events).toHaveLength(0);
    });

    it("returns empty array for invalid JSON", () => {
      const chunk = "event: message_start\ndata: {invalid json}";
      const events = adapter.parseStreamChunk(chunk);
      expect(events).toHaveLength(0);
    });

    it("returns empty array for empty chunk", () => {
      const events = adapter.parseStreamChunk("");
      expect(events).toHaveLength(0);
    });
  });

  describe("buildStreamChunk", () => {
    it("builds message_start SSE frame", () => {
      const event: StreamEvent = {
        type: "message_start",
        id: "msg_1",
        model: "claude-sonnet-4-20250514",
      };

      const result = adapter.buildStreamChunk(event);

      expect(result).toContain("event: message_start\n");
      expect(result).toEndWith("\n\n");

      const dataLine = result.split("\n").find((l) => l.startsWith("data: "));
      expect(dataLine).toBeDefined();
      const data = JSON.parse(dataLine!.slice(6));
      expect(data.type).toBe("message_start");
      expect(data.message.id).toBe("msg_1");
      expect(data.message.model).toBe("claude-sonnet-4-20250514");
      expect(data.message.role).toBe("assistant");
    });

    it("builds content_delta SSE frame", () => {
      const event: StreamEvent = {
        type: "content_delta",
        text: "Hello",
        index: 0,
      };

      const result = adapter.buildStreamChunk(event);

      expect(result).toContain("event: content_block_delta\n");
      const dataLine = result.split("\n").find((l) => l.startsWith("data: "));
      const data = JSON.parse(dataLine!.slice(6));
      expect(data.delta.type).toBe("text_delta");
      expect(data.delta.text).toBe("Hello");
      expect(data.index).toBe(0);
    });

    it("builds content_stop SSE frame", () => {
      const event: StreamEvent = { type: "content_stop", index: 0 };

      const result = adapter.buildStreamChunk(event);

      expect(result).toContain("event: content_block_stop\n");
      const dataLine = result.split("\n").find((l) => l.startsWith("data: "));
      const data = JSON.parse(dataLine!.slice(6));
      expect(data.type).toBe("content_block_stop");
      expect(data.index).toBe(0);
    });

    it("builds message_stop SSE frame without usage", () => {
      const event: StreamEvent = { type: "message_stop" };

      const result = adapter.buildStreamChunk(event);

      expect(result).toContain("event: message_stop\n");
      expect(result).toEndWith("\n\n");
    });

    it("builds message_stop with usage as message_delta + message_stop", () => {
      const event: StreamEvent = {
        type: "message_stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      };

      const result = adapter.buildStreamChunk(event);

      expect(result).toContain("event: message_delta\n");
      expect(result).toContain("event: message_stop\n");

      const lines = result.split("\n");
      const deltaDataLine = lines.find(
        (l) => l.startsWith("data: ") && l.includes("message_delta"),
      );
      expect(deltaDataLine).toBeDefined();
      const deltaData = JSON.parse(deltaDataLine!.slice(6));
      expect(deltaData.usage.input_tokens).toBe(10);
      expect(deltaData.usage.output_tokens).toBe(20);
    });

    it("builds error SSE frame", () => {
      const event: StreamEvent = {
        type: "error",
        message: "something broke",
      };

      const result = adapter.buildStreamChunk(event);

      expect(result).toContain("event: error\n");
      const dataLine = result.split("\n").find((l) => l.startsWith("data: "));
      const data = JSON.parse(dataLine!.slice(6));
      expect(data.error.message).toBe("something broke");
    });
  });

  describe("stream round-trip: parseStreamChunk ↔ buildStreamChunk", () => {
    it("round-trips message_start", () => {
      const original: StreamEvent = {
        type: "message_start",
        id: "msg_rt",
        model: "claude-sonnet-4-20250514",
      };

      const built = adapter.buildStreamChunk(original);
      const frame = built.slice(0, -2);
      const parsed = adapter.parseStreamChunk(frame);

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(original);
    });

    it("round-trips content_delta", () => {
      const original: StreamEvent = {
        type: "content_delta",
        text: "Hello world",
        index: 0,
      };

      const built = adapter.buildStreamChunk(original);
      const frame = built.slice(0, -2);
      const parsed = adapter.parseStreamChunk(frame);

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(original);
    });

    it("round-trips content_stop", () => {
      const original: StreamEvent = { type: "content_stop", index: 0 };

      const built = adapter.buildStreamChunk(original);
      const frame = built.slice(0, -2);
      const parsed = adapter.parseStreamChunk(frame);

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(original);
    });

    it("round-trips message_stop without usage", () => {
      const original: StreamEvent = { type: "message_stop" };

      const built = adapter.buildStreamChunk(original);
      const frame = built.slice(0, -2);
      const parsed = adapter.parseStreamChunk(frame);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].type).toBe("message_stop");
    });
  });

  describe("cross-format: Anthropic → OpenAI Completions", () => {
    it("translates Anthropic stream events to OpenAI SSE format", async () => {
      const { OpenAICompletionsAdapter } = await import(
        "./openai-completions.ts"
      );
      const openaiAdapter = new OpenAICompletionsAdapter();

      const anthropicChunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4-20250514"}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi there"}}',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ];

      const allOpenAIChunks: string[] = [];
      for (const chunk of anthropicChunks) {
        const events = adapter.parseStreamChunk(chunk);
        for (const event of events) {
          allOpenAIChunks.push(openaiAdapter.buildStreamChunk(event));
        }
      }

      expect(allOpenAIChunks.length).toBe(4);

      const firstData = JSON.parse(allOpenAIChunks[0].slice(6, -2));
      expect(firstData.object).toBe("chat.completion.chunk");
      expect(firstData.choices[0].delta.role).toBe("assistant");

      const deltaData = JSON.parse(allOpenAIChunks[1].slice(6, -2));
      expect(deltaData.choices[0].delta.content).toBe("Hi there");

      expect(allOpenAIChunks[3]).toBe("data: [DONE]\n\n");
    });
  });
});
