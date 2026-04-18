import { describe, test, expect } from "bun:test";
import { piStreamToAnthropicSse, piStreamToAnthropicJson } from "./event-to-anthropic.ts";
import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  AssistantMessage,
} from "@mariozechner/pi-ai";

function makeFinalMessage(
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function fauxStream(
  events: AssistantMessageEvent[],
  finalMessage: AssistantMessage,
): AssistantMessageEventStream {
  async function* iterate() {
    for (const e of events) yield e;
  }
  const it = iterate();
  const stream = {
    [Symbol.asyncIterator]() {
      return it;
    },
    async result() {
      return finalMessage;
    },
  } as unknown as AssistantMessageEventStream;
  return stream;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("piStreamToAnthropicSse", () => {
  test("emits message_start, text frames, message_stop", async () => {
    const partial: AssistantMessage = makeFinalMessage();
    const events: AssistantMessageEvent[] = [
      { type: "start", partial },
      { type: "text_start", contentIndex: 0, partial },
      {
        type: "text_delta",
        contentIndex: 0,
        delta: "hi",
        partial,
      },
      {
        type: "text_end",
        contentIndex: 0,
        content: "hi",
        partial,
      },
      {
        type: "done",
        reason: "stop",
        message: makeFinalMessage({
          content: [{ type: "text", text: "hi" }],
          stopReason: "stop",
          usage: {
            input: 1,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      },
    ];
    const out = await collect(
      piStreamToAnthropicSse(fauxStream(events, makeFinalMessage())),
    );
    expect(out).toContain("event: message_start");
    expect(out).toContain("event: content_block_start");
    expect(out).toContain('"text_delta"');
    expect(out).toContain("event: message_delta");
    expect(out).toContain("event: message_stop");
  });

  test("emits thinking and tool_use blocks", async () => {
    const partialWithToolCall = {
      ...makeFinalMessage(),
      content: [
        {
          type: "toolCall" as const,
          id: "t1",
          name: "search",
          arguments: {},
        },
      ],
    };
    const events: AssistantMessageEvent[] = [
      { type: "start", partial: makeFinalMessage() },
      { type: "thinking_start", contentIndex: 0, partial: makeFinalMessage() },
      {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "...",
        partial: makeFinalMessage(),
      },
      {
        type: "thinking_end",
        contentIndex: 0,
        content: "...",
        partial: makeFinalMessage(),
      },
      {
        type: "toolcall_start",
        contentIndex: 1,
        partial: partialWithToolCall,
      },
      {
        type: "toolcall_delta",
        contentIndex: 1,
        delta: '{"q":"x"}',
        partial: partialWithToolCall,
      },
      {
        type: "toolcall_end",
        contentIndex: 1,
        partial: partialWithToolCall,
        toolCall: { type: "toolCall", id: "t1", name: "search", arguments: { q: "x" } },
      },
      {
        type: "done",
        reason: "toolUse",
        message: makeFinalMessage({
          content: [
            { type: "thinking", thinking: "..." },
            { type: "toolCall", id: "t1", name: "search", arguments: { q: "x" } },
          ],
          stopReason: "toolUse",
        }),
      },
    ];
    const out = await collect(
      piStreamToAnthropicSse(fauxStream(events, makeFinalMessage())),
    );
    expect(out).toContain('"thinking"');
    expect(out).toContain("thinking_delta");
    expect(out).toContain('"tool_use"');
    expect(out).toContain("input_json_delta");
    expect(out).toContain("stop_reason");
  });
});

describe("piStreamToAnthropicJson", () => {
  test("produces Anthropic JSON with text and usage", async () => {
    const msg = makeFinalMessage({
      content: [{ type: "text", text: "hello world" }],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
    });
    const out = await piStreamToAnthropicJson(fauxStream([], msg));
    expect(out.type).toBe("message");
    expect(out.role).toBe("assistant");
    expect((out.content as Array<{ type: string; text: string }>)[0].text).toBe("hello world");
    expect(out.stop_reason).toBe("end_turn");
    const usage = out.usage as { input_tokens: number; output_tokens: number };
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
  });

  test("includes tool_use blocks from content", async () => {
    const msg = makeFinalMessage({
      content: [
        { type: "toolCall", id: "t1", name: "search", arguments: { q: "x" } },
      ],
      stopReason: "toolUse",
    });
    const out = await piStreamToAnthropicJson(fauxStream([], msg));
    const content = out.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>;
    expect(content[0].type).toBe("tool_use");
    expect(content[0].id).toBe("t1");
    expect(content[0].name).toBe("search");
    expect(out.stop_reason).toBe("tool_use");
  });

  test("exposes errorMessage when stopReason=error", async () => {
    const msg = makeFinalMessage({
      content: [],
      stopReason: "error",
      errorMessage: "boom",
    });
    const out = await piStreamToAnthropicJson(fauxStream([], msg));
    expect(out.error_message).toBe("boom");
  });
});
