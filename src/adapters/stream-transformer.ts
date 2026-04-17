import type { ApiAdapter } from "./types.ts";
import type { StreamEvent } from "./response-types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createStreamTranslator(
  sourceAdapter: ApiAdapter,
  targetAdapter: ApiAdapter,
): TransformStream<Uint8Array, Uint8Array> {
  if (sourceAdapter.apiType === targetAdapter.apiType) {
    return new TransformStream();
  }

  let buffer = "";
  let messageStarted = false;
  let messageStopped = false;

  function emitEvent(event: StreamEvent, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (event.type === "message_start") {
      messageStarted = true;
    } else if (
      !messageStarted &&
      (event.type === "content_delta" || event.type === "content_stop")
    ) {
      messageStarted = true;
      const synthetic = targetAdapter.buildStreamChunk!({
        type: "message_start",
        id: "",
        model: "",
      });
      if (synthetic) controller.enqueue(encoder.encode(synthetic));
    }

    // Deduplicate message_stop: OpenAI streams emit it from both
    // finish_reason and [DONE]. Only forward the first one.
    if (event.type === "message_stop") {
      if (messageStopped) return;
      messageStopped = true;
    }

    const translated = targetAdapter.buildStreamChunk!(event);
    controller.enqueue(encoder.encode(translated));
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (!sourceAdapter.parseStreamChunk || !targetAdapter.buildStreamChunk) {
        controller.enqueue(chunk);
        return;
      }

      buffer += decoder.decode(chunk, { stream: true });

      let delimiterIndex: number;
      while ((delimiterIndex = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);

        if (frame.trim() === "") continue;

        const events = sourceAdapter.parseStreamChunk(frame);
        for (const event of events) {
          emitEvent(event, controller);
        }
      }
    },

    flush(controller) {
      if (
        buffer.trim() !== "" &&
        sourceAdapter.parseStreamChunk &&
        targetAdapter.buildStreamChunk
      ) {
        const events = sourceAdapter.parseStreamChunk(buffer);
        for (const event of events) {
          emitEvent(event, controller);
        }
      }
    },
  });
}

function getStreamContentType(adapter: ApiAdapter): string {
  switch (adapter.apiType) {
    case "anthropic-messages":
    case "openai-completions":
    case "openai-responses":
      return "text/event-stream";
    case "google-generative-ai":
      return "application/json";
    case "ollama":
      return "application/x-ndjson";
    case "bedrock-converse-stream":
      return "application/vnd.amazon.eventstream";
    default:
      return "text/event-stream";
  }
}

export async function translateResponse(
  sourceAdapter: ApiAdapter,
  targetAdapter: ApiAdapter,
  upstreamResponse: Response,
  streaming: boolean,
): Promise<Response> {
  if (sourceAdapter.apiType === targetAdapter.apiType) {
    return upstreamResponse;
  }

  if (!streaming) {
    return translateNonStreamingResponse(
      sourceAdapter,
      targetAdapter,
      upstreamResponse,
    );
  }

  return translateStreamingResponse(
    sourceAdapter,
    targetAdapter,
    upstreamResponse,
  );
}

async function translateNonStreamingResponse(
  sourceAdapter: ApiAdapter,
  targetAdapter: ApiAdapter,
  upstreamResponse: Response,
): Promise<Response> {
  if (!sourceAdapter.parseResponse || !targetAdapter.buildResponse) {
    return upstreamResponse;
  }

  const body: unknown = await upstreamResponse.json();
  const parsed = sourceAdapter.parseResponse(body);
  const translated = targetAdapter.buildResponse(parsed);

  const headers = copyRelevantHeaders(upstreamResponse.headers);
  headers.set("content-type", "application/json");

  return new Response(JSON.stringify(translated), {
    status: upstreamResponse.status,
    headers,
  });
}

function translateStreamingResponse(
  sourceAdapter: ApiAdapter,
  targetAdapter: ApiAdapter,
  upstreamResponse: Response,
): Response {
  if (!upstreamResponse.body) {
    return upstreamResponse;
  }

  if (
    !sourceAdapter.parseStreamChunk ||
    !targetAdapter.buildStreamChunk
  ) {
    return upstreamResponse;
  }

  const translator = createStreamTranslator(sourceAdapter, targetAdapter);
  const translatedBody = upstreamResponse.body.pipeThrough(translator);

  const headers = copyRelevantHeaders(upstreamResponse.headers);
  headers.set("content-type", getStreamContentType(targetAdapter));

  return new Response(translatedBody, {
    status: upstreamResponse.status,
    headers,
  });
}

function copyRelevantHeaders(source: Headers): Headers {
  const headers = new Headers();
  const passthrough = [
    "cache-control",
    "x-request-id",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
  ];

  for (const name of passthrough) {
    const value = source.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }

  return headers;
}
