import type { ApiAdapter } from "./types.ts";
import type { ParsedResponse } from "./response-types.ts";

export interface CollectOptions {
  allowPrematureEof?: boolean;
}

export async function collectStreamToResponse(
  sourceAdapter: ApiAdapter,
  response: Response,
  options: CollectOptions = {},
): Promise<ParsedResponse> {
  if (!sourceAdapter.parseStreamChunk) {
    throw new Error(
      `collectStreamToResponse: source adapter '${sourceAdapter.apiType}' does not implement parseStreamChunk`,
    );
  }

  if (!response.body) {
    throw new Error(
      `collectStreamToResponse: response has no body (status=${response.status})`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id = "";
  let model = "";
  const textParts: string[] = [];
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let sawTerminalEvent = false;

  const consumeFrame = (frame: string): void => {
    if (!frame.trim() || !sourceAdapter.parseStreamChunk) return;
    for (const event of sourceAdapter.parseStreamChunk(frame)) {
      if (event.type === "message_start") {
        id = event.id ?? id;
        model = event.model ?? model;
      } else if (event.type === "content_delta") {
        textParts.push(event.text ?? "");
      } else if (event.type === "message_stop") {
        sawTerminalEvent = true;
        if (event.usage) usage = event.usage;
      }
    }
  };

  const FRAME_SEPARATOR = /\r?\n\r?\n/;

  const flushFrames = (final: boolean): void => {
    let match = buffer.match(FRAME_SEPARATOR);
    while (match) {
      const idx = match.index ?? -1;
      if (idx < 0) break;
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + match[0].length);
      consumeFrame(frame);
      match = buffer.match(FRAME_SEPARATOR);
    }
    if (final && buffer.trim() !== "") {
      consumeFrame(buffer);
      buffer = "";
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flushFrames(false);
  }

  buffer += decoder.decode();
  flushFrames(true);

  if (!sawTerminalEvent && !options.allowPrematureEof) {
    throw new Error(
      `collectStreamToResponse: stream ended without terminal event (sourceAdapter=${sourceAdapter.apiType}, received ${textParts.length} content deltas)`,
    );
  }

  return {
    id,
    model,
    content: textParts.join(""),
    role: "assistant",
    stopReason: sawTerminalEvent ? "completed" : "incomplete",
    usage,
  };
}

export function isStreamContentType(contentType: string): boolean {
  return (
    contentType.includes("text/event-stream") ||
    contentType.includes("application/x-ndjson")
  );
}
