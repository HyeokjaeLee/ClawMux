import { describe, expect, it } from "bun:test";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";
import type { ApiAdapter } from "./types.ts";
import { createStreamTranslator, translateResponse } from "./stream-transformer.ts";

function makeMockAdapter(
  apiType: string,
  overrides?: Partial<ApiAdapter>,
): ApiAdapter {
  return {
    apiType,
    parseRequest: () => ({
      model: "test",
      messages: [],
      stream: false,
      rawBody: {},
    }),
    buildUpstreamRequest: () => ({
      url: "",
      method: "POST",
      headers: {},
      body: "",
    }),
    modifyMessages: (raw) => raw,
    ...overrides,
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function collectStream(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  let result = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

function makeReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

describe("StreamEvent type validation", () => {
  it("creates message_start event", () => {
    const event: StreamEvent = {
      type: "message_start",
      id: "msg_123",
      model: "test-model",
    };
    expect(event.type).toBe("message_start");
    expect(event.id).toBe("msg_123");
    expect(event.model).toBe("test-model");
  });

  it("creates content_delta event", () => {
    const event: StreamEvent = {
      type: "content_delta",
      text: "Hello",
      index: 0,
    };
    expect(event.type).toBe("content_delta");
    expect(event.text).toBe("Hello");
    expect(event.index).toBe(0);
  });

  it("creates content_stop event", () => {
    const event: StreamEvent = { type: "content_stop", index: 0 };
    expect(event.type).toBe("content_stop");
  });

  it("creates message_stop event with usage", () => {
    const event: StreamEvent = {
      type: "message_stop",
      usage: { inputTokens: 10, outputTokens: 20 },
    };
    expect(event.type).toBe("message_stop");
    expect(event.usage?.inputTokens).toBe(10);
  });

  it("creates message_stop event without usage", () => {
    const event: StreamEvent = { type: "message_stop" };
    expect(event.usage).toBeUndefined();
  });

  it("creates error event", () => {
    const event: StreamEvent = { type: "error", message: "something broke" };
    expect(event.type).toBe("error");
    expect(event.message).toBe("something broke");
  });
});

describe("ParsedResponse creation", () => {
  it("creates a valid ParsedResponse", () => {
    const response: ParsedResponse = {
      id: "resp_123",
      model: "test-model",
      content: "Hello, world!",
      role: "assistant",
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 3 },
    };
    expect(response.role).toBe("assistant");
    expect(response.stopReason).toBe("end_turn");
    expect(response.usage?.outputTokens).toBe(3);
  });

  it("allows null stopReason", () => {
    const response: ParsedResponse = {
      id: "resp_456",
      model: "test-model",
      content: "Partial",
      role: "assistant",
      stopReason: null,
    };
    expect(response.stopReason).toBeNull();
    expect(response.usage).toBeUndefined();
  });
});

describe("createStreamTranslator", () => {
  it("passes through when source and target have same apiType", async () => {
    const adapter = makeMockAdapter("anthropic-messages");
    const translator = createStreamTranslator(adapter, adapter);

    const input = makeReadableStream(["hello", " world"]);
    const output = input.pipeThrough(translator);
    const result = await collectStream(output);

    expect(result).toBe("hello world");
  });

  it("translates stream events between different adapters", async () => {
    const sourceEvents: StreamEvent[] = [
      { type: "message_start", id: "msg_1", model: "source-model" },
      { type: "content_delta", text: "Hi", index: 0 },
      { type: "message_stop" },
    ];

    let parseCallIndex = 0;
    const source = makeMockAdapter("source-type", {
      parseStreamChunk: () => {
        const event = sourceEvents[parseCallIndex];
        parseCallIndex++;
        return event ? [event] : [];
      },
    });

    const builtChunks: string[] = [];
    const target = makeMockAdapter("target-type", {
      buildStreamChunk: (event: StreamEvent) => {
        const chunk = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        builtChunks.push(chunk);
        return chunk;
      },
    });

    const frames = sourceEvents.map(
      (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
    );
    const input = makeReadableStream(frames);
    const output = input.pipeThrough(
      createStreamTranslator(source, target),
    );

    const result = await collectStream(output);

    expect(builtChunks.length).toBe(3);
    expect(result).toContain("message_start");
    expect(result).toContain("content_delta");
    expect(result).toContain("message_stop");
  });

  it("buffers partial SSE frames across chunks", async () => {
    const parsedEvents: StreamEvent[][] = [];
    const source = makeMockAdapter("source-type", {
      parseStreamChunk: (chunk: string) => {
        const event: StreamEvent = {
          type: "content_delta",
          text: chunk.trim(),
          index: 0,
        };
        parsedEvents.push([event]);
        return [event];
      },
    });

    const target = makeMockAdapter("target-type", {
      buildStreamChunk: (event: StreamEvent) =>
        `data: ${JSON.stringify(event)}\n\n`,
    });

    const input = makeReadableStream([
      "event: content_delta\nda",
      "ta: {\"text\":\"hello\"}\n",
      "\n",
    ]);

    const output = input.pipeThrough(
      createStreamTranslator(source, target),
    );
    const result = await collectStream(output);

    expect(parsedEvents.length).toBe(1);
    expect(result).toContain("content_delta");
  });

  it("passes through when adapters lack stream methods", async () => {
    const source = makeMockAdapter("source-type");
    const target = makeMockAdapter("target-type");

    const input = makeReadableStream(["raw data"]);
    const output = input.pipeThrough(
      createStreamTranslator(source, target),
    );
    const result = await collectStream(output);

    expect(result).toBe("raw data");
  });

  it("flushes remaining buffer on stream end", async () => {
    const source = makeMockAdapter("source-type", {
      parseStreamChunk: (chunk: string) => {
        const event: StreamEvent = {
          type: "content_delta",
          text: chunk.trim(),
          index: 0,
        };
        return [event];
      },
    });

    const target = makeMockAdapter("target-type", {
      buildStreamChunk: (event: StreamEvent) =>
        `data: ${JSON.stringify(event)}\n\n`,
    });

    const input = makeReadableStream(["no-trailing-newlines"]);
    const output = input.pipeThrough(
      createStreamTranslator(source, target),
    );
    const result = await collectStream(output);

    expect(result).toContain("content_delta");
    expect(result).toContain("no-trailing-newlines");
  });
});

describe("translateResponse", () => {
  describe("non-streaming", () => {
    it("returns upstream response as-is for same adapter type", async () => {
      const adapter = makeMockAdapter("anthropic-messages");
      const upstream = new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });

      const result = await translateResponse(adapter, adapter, upstream, false);
      expect(result).toBe(upstream);
    });

    it("parses and rebuilds response for different adapters", async () => {
      const parsed: ParsedResponse = {
        id: "resp_1",
        model: "source-model",
        content: "Hello!",
        role: "assistant",
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      const source = makeMockAdapter("source-type", {
        parseResponse: () => parsed,
      });

      const rebuilt = {
        id: "resp_1",
        choices: [{ message: { content: "Hello!" } }],
      };
      const target = makeMockAdapter("target-type", {
        buildResponse: () => rebuilt,
      });

      const upstream = new Response(
        JSON.stringify({ content: [{ text: "Hello!" }] }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_abc",
            "x-unrelated-header": "should-be-dropped",
          },
        },
      );

      const result = await translateResponse(source, target, upstream, false);
      const body = await result.json();

      expect(result.status).toBe(200);
      expect(body.id).toBe("resp_1");
      expect(body.choices[0].message.content).toBe("Hello!");
      expect(result.headers.get("content-type")).toBe("application/json");
      expect(result.headers.get("x-request-id")).toBe("req_abc");
      expect(result.headers.get("x-unrelated-header")).toBeNull();
    });

    it("returns upstream when adapters lack response methods", async () => {
      const source = makeMockAdapter("source-type");
      const target = makeMockAdapter("target-type");

      const upstream = new Response('{"raw":true}', { status: 200 });
      const result = await translateResponse(source, target, upstream, false);

      expect(result).toBe(upstream);
    });
  });

  describe("streaming", () => {
    it("returns upstream response as-is for same adapter type", async () => {
      const adapter = makeMockAdapter("anthropic-messages");
      const upstream = new Response(
        makeReadableStream(["data: test\n\n"]),
        { status: 200 },
      );

      const result = await translateResponse(adapter, adapter, upstream, true);
      expect(result).toBe(upstream);
    });

    it("transforms streaming response between different adapters", async () => {
      const source = makeMockAdapter("source-type", {
        parseStreamChunk: (chunk: string) => {
          const event: StreamEvent = {
            type: "content_delta",
            text: chunk.trim(),
            index: 0,
          };
          return [event];
        },
      });

      const target = makeMockAdapter("openai-completions", {
        buildStreamChunk: (event: StreamEvent) =>
          `data: ${JSON.stringify(event)}\n\n`,
      });

      const upstream = new Response(
        makeReadableStream(["hello world\n\n"]),
        {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
        },
      );

      const result = await translateResponse(source, target, upstream, true);

      expect(result.status).toBe(200);
      expect(result.headers.get("content-type")).toBe("text/event-stream");
      expect(result.headers.get("cache-control")).toBe("no-cache");

      const body = await collectStream(
        result.body as ReadableStream<Uint8Array>,
      );
      expect(body).toContain("content_delta");
      expect(body).toContain("hello world");
    });

    it("returns upstream when adapters lack stream methods", async () => {
      const source = makeMockAdapter("source-type");
      const target = makeMockAdapter("target-type");

      const upstream = new Response(
        makeReadableStream(["raw stream"]),
        { status: 200 },
      );

      const result = await translateResponse(source, target, upstream, true);
      expect(result).toBe(upstream);
    });

    it("returns upstream when body is null", async () => {
      const source = makeMockAdapter("source-type", {
        parseStreamChunk: () => [],
      });
      const target = makeMockAdapter("target-type", {
        buildStreamChunk: () => "",
      });

      const upstream = new Response(null, { status: 200 });
      const result = await translateResponse(source, target, upstream, true);
      expect(result).toBe(upstream);
    });
  });
});
