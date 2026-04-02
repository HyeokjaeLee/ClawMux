import { describe, expect, it } from "bun:test";
import { OpenAICompletionsAdapter } from "./openai-completions.ts";
import { OpenAIResponsesAdapter } from "./openai-responses.ts";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";

const completions = new OpenAICompletionsAdapter();
const responses = new OpenAIResponsesAdapter();

describe("OpenAICompletionsAdapter response methods", () => {
  describe("parseResponse", () => {
    it("parses a valid OpenAI chat completion response", () => {
      const body = {
        id: "chatcmpl-abc123",
        object: "chat.completion",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Hello, world!" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      };

      const result = completions.parseResponse(body);

      expect(result.id).toBe("chatcmpl-abc123");
      expect(result.model).toBe("gpt-4o");
      expect(result.content).toBe("Hello, world!");
      expect(result.role).toBe("assistant");
      expect(result.stopReason).toBe("stop");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("handles null finish_reason", () => {
      const body = {
        id: "chatcmpl-456",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Partial" },
            finish_reason: null,
          },
        ],
      };

      const result = completions.parseResponse(body);
      expect(result.stopReason).toBeNull();
    });

    it("handles missing usage", () => {
      const body = {
        id: "chatcmpl-789",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "No usage" },
            finish_reason: "stop",
          },
        ],
      };

      const result = completions.parseResponse(body);
      expect(result.usage).toBeUndefined();
    });

    it("handles empty choices array", () => {
      const body = {
        id: "chatcmpl-empty",
        model: "gpt-4o",
        choices: [],
      };

      const result = completions.parseResponse(body);
      expect(result.content).toBe("");
      expect(result.stopReason).toBeNull();
    });
  });

  describe("buildResponse", () => {
    it("builds a valid OpenAI chat completion response", () => {
      const parsed: ParsedResponse = {
        id: "chatcmpl-abc123",
        model: "gpt-4o",
        content: "Hello, world!",
        role: "assistant",
        stopReason: "stop",
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      const result = completions.buildResponse(parsed);

      expect(result.id).toBe("chatcmpl-abc123");
      expect(result.object).toBe("chat.completion");
      expect(result.model).toBe("gpt-4o");

      const choices = result.choices as Array<Record<string, unknown>>;
      expect(choices).toHaveLength(1);
      expect(choices[0].index).toBe(0);
      expect(choices[0].finish_reason).toBe("stop");

      const message = choices[0].message as Record<string, unknown>;
      expect(message.role).toBe("assistant");
      expect(message.content).toBe("Hello, world!");

      const usage = result.usage as Record<string, number>;
      expect(usage.prompt_tokens).toBe(10);
      expect(usage.completion_tokens).toBe(5);
      expect(usage.total_tokens).toBe(15);
    });

    it("omits usage when not present", () => {
      const parsed: ParsedResponse = {
        id: "chatcmpl-no-usage",
        model: "gpt-4o",
        content: "No usage",
        role: "assistant",
        stopReason: "stop",
      };

      const result = completions.buildResponse(parsed);
      expect(result.usage).toBeUndefined();
    });
  });

  describe("round-trip: parseResponse ↔ buildResponse", () => {
    it("preserves data through build → parse cycle", () => {
      const original: ParsedResponse = {
        id: "chatcmpl-roundtrip",
        model: "gpt-4o",
        content: "Round trip test",
        role: "assistant",
        stopReason: "stop",
        usage: { inputTokens: 15, outputTokens: 8 },
      };

      const built = completions.buildResponse(original);
      const parsed = completions.parseResponse(built);

      expect(parsed.id).toBe(original.id);
      expect(parsed.model).toBe(original.model);
      expect(parsed.content).toBe(original.content);
      expect(parsed.role).toBe(original.role);
      expect(parsed.stopReason).toBe(original.stopReason);
      expect(parsed.usage).toEqual(original.usage);
    });
  });

  describe("parseStreamChunk", () => {
    it("parses role-only delta as message_start", () => {
      const chunk =
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}';

      const events = completions.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("message_start");
      if (events[0].type === "message_start") {
        expect(events[0].id).toBe("chatcmpl-1");
        expect(events[0].model).toBe("gpt-4o");
      }
    });

    it("parses content delta", () => {
      const chunk =
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}';

      const events = completions.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("content_delta");
      if (events[0].type === "content_delta") {
        expect(events[0].text).toBe("Hello");
        expect(events[0].index).toBe(0);
      }
    });

    it("parses finish_reason as content_stop + message_stop", () => {
      const chunk =
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}';

      const events = completions.parseStreamChunk(chunk);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("content_stop");
      expect(events[1].type).toBe("message_stop");
    });

    it("parses finish_reason with usage", () => {
      const chunk =
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}';

      const events = completions.parseStreamChunk(chunk);

      expect(events).toHaveLength(2);
      if (events[1].type === "message_stop") {
        expect(events[1].usage).toEqual({
          inputTokens: 10,
          outputTokens: 5,
        });
      }
    });

    it("parses [DONE] as message_stop", () => {
      const chunk = "data: [DONE]";

      const events = completions.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("message_stop");
    });

    it("returns empty array for invalid JSON", () => {
      const chunk = "data: {invalid}";
      const events = completions.parseStreamChunk(chunk);
      expect(events).toHaveLength(0);
    });

    it("returns empty array for empty chunk", () => {
      const events = completions.parseStreamChunk("");
      expect(events).toHaveLength(0);
    });

    it("handles content delta with empty string", () => {
      const chunk =
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":""},"finish_reason":null}]}';

      const events = completions.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("content_delta");
      if (events[0].type === "content_delta") {
        expect(events[0].text).toBe("");
      }
    });
  });

  describe("buildStreamChunk", () => {
    it("builds message_start SSE frame", () => {
      const event: StreamEvent = {
        type: "message_start",
        id: "chatcmpl-1",
        model: "gpt-4o",
      };

      const result = completions.buildStreamChunk(event);

      expect(result).toStartWith("data: ");
      expect(result).toEndWith("\n\n");

      const data = JSON.parse(result.slice(6, -2));
      expect(data.id).toBe("chatcmpl-1");
      expect(data.object).toBe("chat.completion.chunk");
      expect(data.model).toBe("gpt-4o");
      expect(data.choices[0].delta.role).toBe("assistant");
      expect(data.choices[0].finish_reason).toBeNull();
    });

    it("builds content_delta SSE frame", () => {
      const event: StreamEvent = {
        type: "content_delta",
        text: "Hello",
        index: 0,
      };

      const result = completions.buildStreamChunk(event);
      const data = JSON.parse(result.slice(6, -2));

      expect(data.choices[0].delta.content).toBe("Hello");
      expect(data.choices[0].finish_reason).toBeNull();
    });

    it("builds content_stop SSE frame with finish_reason", () => {
      const event: StreamEvent = { type: "content_stop", index: 0 };

      const result = completions.buildStreamChunk(event);
      const data = JSON.parse(result.slice(6, -2));

      expect(data.choices[0].finish_reason).toBe("stop");
      expect(data.choices[0].delta).toEqual({});
    });

    it("builds message_stop as [DONE]", () => {
      const event: StreamEvent = { type: "message_stop" };

      const result = completions.buildStreamChunk(event);
      expect(result).toBe("data: [DONE]\n\n");
    });

    it("builds error SSE frame", () => {
      const event: StreamEvent = {
        type: "error",
        message: "rate limited",
      };

      const result = completions.buildStreamChunk(event);
      const data = JSON.parse(result.slice(6, -2));
      expect(data.error.message).toBe("rate limited");
    });
  });

  describe("stream round-trip: parseStreamChunk ↔ buildStreamChunk", () => {
    it("round-trips message_start", () => {
      const original: StreamEvent = {
        type: "message_start",
        id: "chatcmpl-rt",
        model: "gpt-4o",
      };

      const built = completions.buildStreamChunk(original);
      const frame = built.slice(0, -2);
      const parsed = completions.parseStreamChunk(frame);

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(original);
    });

    it("round-trips content_delta", () => {
      const original: StreamEvent = {
        type: "content_delta",
        text: "Hello world",
        index: 0,
      };

      const built = completions.buildStreamChunk(original);
      const frame = built.slice(0, -2);
      const parsed = completions.parseStreamChunk(frame);

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(original);
    });

    it("round-trips [DONE] → message_stop", () => {
      const original: StreamEvent = { type: "message_stop" };

      const built = completions.buildStreamChunk(original);
      const frame = built.slice(0, -2);
      const parsed = completions.parseStreamChunk(frame);

      expect(parsed).toHaveLength(1);
      expect(parsed[0].type).toBe("message_stop");
    });
  });
});

describe("OpenAIResponsesAdapter response methods", () => {
  describe("parseResponse", () => {
    it("parses a valid OpenAI Responses API body", () => {
      const body = {
        id: "resp_abc123",
        object: "response",
        model: "gpt-4o",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "Hello, world!" },
            ],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
      };

      const result = responses.parseResponse(body);

      expect(result.id).toBe("resp_abc123");
      expect(result.model).toBe("gpt-4o");
      expect(result.content).toBe("Hello, world!");
      expect(result.role).toBe("assistant");
      expect(result.stopReason).toBe("completed");
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it("concatenates multiple output_text parts", () => {
      const body = {
        id: "resp_multi",
        model: "gpt-4o",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "Part one. " },
              { type: "output_text", text: "Part two." },
            ],
          },
        ],
      };

      const result = responses.parseResponse(body);
      expect(result.content).toBe("Part one. Part two.");
    });

    it("handles missing usage", () => {
      const body = {
        id: "resp_no_usage",
        model: "gpt-4o",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "No usage" }],
          },
        ],
      };

      const result = responses.parseResponse(body);
      expect(result.usage).toBeUndefined();
    });

    it("handles empty output array", () => {
      const body = {
        id: "resp_empty",
        model: "gpt-4o",
        status: "completed",
        output: [],
      };

      const result = responses.parseResponse(body);
      expect(result.content).toBe("");
    });
  });

  describe("buildResponse", () => {
    it("builds a valid OpenAI Responses format", () => {
      const parsed: ParsedResponse = {
        id: "resp_abc123",
        model: "gpt-4o",
        content: "Hello, world!",
        role: "assistant",
        stopReason: "completed",
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      const result = responses.buildResponse(parsed);

      expect(result.id).toBe("resp_abc123");
      expect(result.object).toBe("response");
      expect(result.model).toBe("gpt-4o");
      expect(result.status).toBe("completed");

      const output = result.output as Array<Record<string, unknown>>;
      expect(output).toHaveLength(1);
      expect(output[0].type).toBe("message");
      expect(output[0].role).toBe("assistant");

      const content = output[0].content as Array<Record<string, unknown>>;
      expect(content[0].type).toBe("output_text");
      expect(content[0].text).toBe("Hello, world!");

      const usage = result.usage as Record<string, number>;
      expect(usage.input_tokens).toBe(10);
      expect(usage.output_tokens).toBe(5);
      expect(usage.total_tokens).toBe(15);
    });

    it("defaults status to 'completed' when stopReason is null", () => {
      const parsed: ParsedResponse = {
        id: "resp_null_stop",
        model: "gpt-4o",
        content: "Test",
        role: "assistant",
        stopReason: null,
      };

      const result = responses.buildResponse(parsed);
      expect(result.status).toBe("completed");
    });
  });

  describe("round-trip: parseResponse ↔ buildResponse", () => {
    it("preserves data through build → parse cycle", () => {
      const original: ParsedResponse = {
        id: "resp_roundtrip",
        model: "gpt-4o",
        content: "Round trip test",
        role: "assistant",
        stopReason: "completed",
        usage: { inputTokens: 15, outputTokens: 8 },
      };

      const built = responses.buildResponse(original);
      const parsed = responses.parseResponse(built);

      expect(parsed.id).toBe(original.id);
      expect(parsed.model).toBe(original.model);
      expect(parsed.content).toBe(original.content);
      expect(parsed.role).toBe(original.role);
      expect(parsed.stopReason).toBe(original.stopReason);
      expect(parsed.usage).toEqual(original.usage);
    });
  });

  describe("parseStreamChunk", () => {
    it("parses response.created as message_start", () => {
      const chunk =
        'data: {"type":"response.created","response":{"id":"resp_1","object":"response","model":"gpt-4o","status":"in_progress"}}';

      const events = responses.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("message_start");
      if (events[0].type === "message_start") {
        expect(events[0].id).toBe("resp_1");
        expect(events[0].model).toBe("gpt-4o");
      }
    });

    it("parses response.output_text.delta as content_delta", () => {
      const chunk =
        'data: {"type":"response.output_text.delta","output_index":0,"delta":"Hello"}';

      const events = responses.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("content_delta");
      if (events[0].type === "content_delta") {
        expect(events[0].text).toBe("Hello");
        expect(events[0].index).toBe(0);
      }
    });

    it("parses response.output_text.done as content_stop", () => {
      const chunk =
        'data: {"type":"response.output_text.done","output_index":0}';

      const events = responses.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("content_stop");
      if (events[0].type === "content_stop") {
        expect(events[0].index).toBe(0);
      }
    });

    it("parses response.completed as message_stop with usage", () => {
      const chunk =
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":20,"output_tokens":10}}}';

      const events = responses.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("message_stop");
      if (events[0].type === "message_stop") {
        expect(events[0].usage).toEqual({
          inputTokens: 20,
          outputTokens: 10,
        });
      }
    });

    it("parses response.completed without usage", () => {
      const chunk = 'data: {"type":"response.completed"}';

      const events = responses.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("message_stop");
      if (events[0].type === "message_stop") {
        expect(events[0].usage).toBeUndefined();
      }
    });

    it("parses [DONE] as message_stop", () => {
      const chunk = "data: [DONE]";

      const events = responses.parseStreamChunk(chunk);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("message_stop");
    });

    it("returns empty array for unknown event types", () => {
      const chunk = 'data: {"type":"response.unknown_event"}';
      const events = responses.parseStreamChunk(chunk);
      expect(events).toHaveLength(0);
    });

    it("returns empty array for empty chunk", () => {
      const events = responses.parseStreamChunk("");
      expect(events).toHaveLength(0);
    });
  });

  describe("buildStreamChunk", () => {
    it("builds response.created SSE frame", () => {
      const event: StreamEvent = {
        type: "message_start",
        id: "resp_1",
        model: "gpt-4o",
      };

      const result = responses.buildStreamChunk(event);

      expect(result).toStartWith("data: ");
      expect(result).toEndWith("\n\n");

      const data = JSON.parse(result.slice(6, -2));
      expect(data.type).toBe("response.created");
      expect(data.response.id).toBe("resp_1");
      expect(data.response.model).toBe("gpt-4o");
    });

    it("builds response.output_text.delta SSE frame", () => {
      const event: StreamEvent = {
        type: "content_delta",
        text: "Hello",
        index: 0,
      };

      const result = responses.buildStreamChunk(event);
      const data = JSON.parse(result.slice(6, -2));

      expect(data.type).toBe("response.output_text.delta");
      expect(data.delta).toBe("Hello");
      expect(data.output_index).toBe(0);
    });

    it("builds response.output_text.done SSE frame", () => {
      const event: StreamEvent = { type: "content_stop", index: 0 };

      const result = responses.buildStreamChunk(event);
      const data = JSON.parse(result.slice(6, -2));

      expect(data.type).toBe("response.output_text.done");
      expect(data.output_index).toBe(0);
    });

    it("builds response.completed SSE frame without usage", () => {
      const event: StreamEvent = { type: "message_stop" };

      const result = responses.buildStreamChunk(event);
      const data = JSON.parse(result.slice(6, -2));

      expect(data.type).toBe("response.completed");
      expect(data.response).toBeUndefined();
    });

    it("builds response.completed SSE frame with usage", () => {
      const event: StreamEvent = {
        type: "message_stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      };

      const result = responses.buildStreamChunk(event);
      const data = JSON.parse(result.slice(6, -2));

      expect(data.type).toBe("response.completed");
      expect(data.response.usage.input_tokens).toBe(10);
      expect(data.response.usage.output_tokens).toBe(20);
    });

    it("builds error SSE frame", () => {
      const event: StreamEvent = {
        type: "error",
        message: "server error",
      };

      const result = responses.buildStreamChunk(event);
      const data = JSON.parse(result.slice(6, -2));
      expect(data.type).toBe("error");
      expect(data.error.message).toBe("server error");
    });
  });

  describe("stream round-trip: parseStreamChunk ↔ buildStreamChunk", () => {
    it("round-trips message_start", () => {
      const original: StreamEvent = {
        type: "message_start",
        id: "resp_rt",
        model: "gpt-4o",
      };

      const built = responses.buildStreamChunk(original);
      const frame = built.slice(0, -2);
      const parsed = responses.parseStreamChunk(frame);

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(original);
    });

    it("round-trips content_delta", () => {
      const original: StreamEvent = {
        type: "content_delta",
        text: "Hello world",
        index: 0,
      };

      const built = responses.buildStreamChunk(original);
      const frame = built.slice(0, -2);
      const parsed = responses.parseStreamChunk(frame);

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(original);
    });

    it("round-trips content_stop", () => {
      const original: StreamEvent = { type: "content_stop", index: 0 };

      const built = responses.buildStreamChunk(original);
      const frame = built.slice(0, -2);
      const parsed = responses.parseStreamChunk(frame);

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(original);
    });

    it("round-trips message_stop with usage", () => {
      const original: StreamEvent = {
        type: "message_stop",
        usage: { inputTokens: 10, outputTokens: 20 },
      };

      const built = responses.buildStreamChunk(original);
      const frame = built.slice(0, -2);
      const parsed = responses.parseStreamChunk(frame);

      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toEqual(original);
    });
  });

  describe("cross-format: OpenAI Completions → Anthropic", () => {
    it("translates OpenAI stream events to Anthropic SSE format", async () => {
      const { AnthropicAdapter } = await import("./anthropic.ts");
      const anthropicAdapter = new AnthropicAdapter();

      const openaiChunks = [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hi there"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
      ];

      const allAnthropicChunks: string[] = [];
      for (const chunk of openaiChunks) {
        const events = completions.parseStreamChunk(chunk);
        for (const event of events) {
          allAnthropicChunks.push(anthropicAdapter.buildStreamChunk(event));
        }
      }

      expect(allAnthropicChunks.length).toBeGreaterThanOrEqual(4);

      expect(allAnthropicChunks[0]).toContain("event: message_start");
      expect(allAnthropicChunks[1]).toContain("event: content_block_delta");
      expect(allAnthropicChunks[1]).toContain("Hi there");
    });
  });

  describe("cross-format: OpenAI Completions ↔ OpenAI Responses", () => {
    it("translates completions stream to responses stream", () => {
      const completionsChunks = [
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
        "data: [DONE]",
      ];

      const allResponsesChunks: string[] = [];
      for (const chunk of completionsChunks) {
        const events = completions.parseStreamChunk(chunk);
        for (const event of events) {
          allResponsesChunks.push(responses.buildStreamChunk(event));
        }
      }

      expect(allResponsesChunks.length).toBe(3);

      const firstData = JSON.parse(allResponsesChunks[0].slice(6, -2));
      expect(firstData.type).toBe("response.created");

      const deltaData = JSON.parse(allResponsesChunks[1].slice(6, -2));
      expect(deltaData.type).toBe("response.output_text.delta");
      expect(deltaData.delta).toBe("Hello");

      const doneData = JSON.parse(allResponsesChunks[2].slice(6, -2));
      expect(doneData.type).toBe("response.completed");
    });
  });
});
