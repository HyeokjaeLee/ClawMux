import { describe, expect, it } from "bun:test";
import type { ApiAdapter, ParsedRequest, UpstreamRequest } from "./types.ts";
import { collectStreamToResponse, isStreamContentType } from "./stream-collector.ts";

function createMockStreamAdapter(): ApiAdapter {
  return {
    apiType: "mock",
    parseRequest(): ParsedRequest {
      return { model: "", messages: [], stream: true, rawBody: {} };
    },
    buildUpstreamRequest(): UpstreamRequest {
      return { url: "", method: "POST", headers: {}, body: "" };
    },
    modifyMessages(r: Record<string, unknown>) {
      return r;
    },
    parseStreamChunk(chunk: string) {
      const events = [];
      for (const line of chunk.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") {
          events.push({ type: "message_stop" as const });
          continue;
        }
        try {
          const data = JSON.parse(payload) as Record<string, unknown>;
          if (data.type === "start") {
            events.push({
              type: "message_start" as const,
              id: String(data.id ?? ""),
              model: String(data.model ?? ""),
            });
          } else if (data.type === "delta") {
            events.push({
              type: "content_delta" as const,
              text: String(data.text ?? ""),
              index: 0,
            });
          }
        } catch {
          continue;
        }
      }
      return events;
    },
  };
}

function chunkedResponse(chunks: Uint8Array[], contentType = "text/event-stream"): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

describe("collectStreamToResponse", () => {
  const adapter = createMockStreamAdapter();
  const enc = new TextEncoder();

  it("parses simple SSE with LF framing", async () => {
    const body =
      'data: {"type":"start","id":"m1","model":"x"}\n\n' +
      'data: {"type":"delta","text":"hello "}\n\n' +
      'data: {"type":"delta","text":"world"}\n\n' +
      "data: [DONE]\n\n";
    const resp = chunkedResponse([enc.encode(body)]);

    const result = await collectStreamToResponse(adapter, resp);

    expect(result.id).toBe("m1");
    expect(result.model).toBe("x");
    expect(result.content).toBe("hello world");
  });

  it("parses SSE with CRLF framing", async () => {
    const body =
      'data: {"type":"start","id":"m2","model":"y"}\r\n\r\n' +
      'data: {"type":"delta","text":"crlf-"}\r\n\r\n' +
      'data: {"type":"delta","text":"works"}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";
    const resp = chunkedResponse([enc.encode(body)]);

    const result = await collectStreamToResponse(adapter, resp);
    expect(result.content).toBe("crlf-works");
  });

  it("parses SSE split across chunk boundaries mid-frame", async () => {
    const frames = [
      'data: {"type":"start","id":"m3","model":"z"}\n\n',
      'data: {"type":"delta","text":"a'.slice(0, 20),
      '"type":"delta","text":"a"}\n\n',
      'data: {"type":"delta","text":"b"}\n\n',
      "data: [DONE]\n\n",
    ];
    const body =
      'data: {"type":"start","id":"m3","model":"z"}\n\n' +
      'data: {"type":"delta","text":"aa"}\n\n' +
      'data: {"type":"delta","text":"bb"}\n\n' +
      "data: [DONE]\n\n";

    const bytes = enc.encode(body);
    const mid = Math.floor(bytes.length / 2);
    const chunks = [bytes.slice(0, mid), bytes.slice(mid)];
    const resp = chunkedResponse(chunks);

    const result = await collectStreamToResponse(adapter, resp);
    expect(result.content).toBe("aabb");
    void frames;
  });

  it("correctly joins UTF-8 codepoint split across chunks", async () => {
    const msg = "데이터";
    const body =
      `data: {"type":"delta","text":"${msg}"}\n\n` +
      "data: [DONE]\n\n";
    const bytes = enc.encode(body);
    const split = 30;
    const chunks = [bytes.slice(0, split), bytes.slice(split)];
    const resp = chunkedResponse(chunks);

    const result = await collectStreamToResponse(adapter, resp);
    expect(result.content).toBe(msg);
    expect(result.stopReason).toBe("completed");
  });

  it("consumes trailing frame without separator when allowed", async () => {
    const body = 'data: {"type":"delta","text":"orphan"}\n';
    const resp = chunkedResponse([enc.encode(body)]);

    const result = await collectStreamToResponse(adapter, resp, {
      allowPrematureEof: true,
    });
    expect(result.content).toBe("orphan");
    expect(result.stopReason).toBe("incomplete");
  });

  it("throws on premature EOF (no terminal event) by default", async () => {
    const body = 'data: {"type":"delta","text":"partial"}\n\n';
    const resp = chunkedResponse([enc.encode(body)]);

    await expect(collectStreamToResponse(adapter, resp)).rejects.toThrow(
      /stream ended without terminal event/,
    );
  });

  it("returns incomplete stopReason when allowPrematureEof=true", async () => {
    const body = 'data: {"type":"delta","text":"partial"}\n\n';
    const resp = chunkedResponse([enc.encode(body)]);

    const result = await collectStreamToResponse(adapter, resp, {
      allowPrematureEof: true,
    });
    expect(result.stopReason).toBe("incomplete");
    expect(result.content).toBe("partial");
  });

  it("throws when adapter lacks parseStreamChunk", async () => {
    const noStreamAdapter: ApiAdapter = {
      apiType: "no-stream",
      parseRequest(): ParsedRequest {
        return { model: "", messages: [], stream: false, rawBody: {} };
      },
      buildUpstreamRequest(): UpstreamRequest {
        return { url: "", method: "POST", headers: {}, body: "" };
      },
      modifyMessages(r: Record<string, unknown>) {
        return r;
      },
    };
    const resp = chunkedResponse([enc.encode("ignored")]);

    await expect(collectStreamToResponse(noStreamAdapter, resp)).rejects.toThrow(
      /does not implement parseStreamChunk/,
    );
  });
});

describe("isStreamContentType", () => {
  it("detects text/event-stream", () => {
    expect(isStreamContentType("text/event-stream")).toBe(true);
    expect(isStreamContentType("text/event-stream; charset=utf-8")).toBe(true);
  });

  it("detects application/x-ndjson", () => {
    expect(isStreamContentType("application/x-ndjson")).toBe(true);
  });

  it("does NOT claim to support bedrock eventstream (binary format)", () => {
    expect(isStreamContentType("application/vnd.amazon.eventstream")).toBe(false);
  });

  it("rejects regular JSON", () => {
    expect(isStreamContentType("application/json")).toBe(false);
  });

  it("handles empty", () => {
    expect(isStreamContentType("")).toBe(false);
  });
});
