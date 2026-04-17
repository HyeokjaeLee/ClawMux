import type {
  ApiAdapter,
  AuthInfo,
  ParsedRequest,
  UpstreamRequest,
} from "./types.ts";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";
import { registerAdapter } from "./registry.ts";
import { parseOpenAIBody } from "./openai-shared.ts";
import { openaiResponsesAdapter } from "./openai-responses.ts";


const CONTENT_TYPE_MAP: Record<string, string> = {
  text: "input_text",
  image_url: "input_image",
};

function convertContentPart(part: Record<string, unknown>): Record<string, unknown> {
  const partType = String(part.type ?? "");
  const mapped = CONTENT_TYPE_MAP[partType];
  if (mapped) {
    return { ...part, type: mapped };
  }
  return part;
}

const STRIP_KEYS = new Set(["tool_calls", "tool_call_id", "name", "function_call"]);

function toResponsesInput(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return messages
    .filter((msg) => msg.role !== "tool")
    .map((msg) => {
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(msg)) {
        if (!STRIP_KEYS.has(key)) {
          cleaned[key] = value;
        }
      }

      const content = cleaned.content;
      if (Array.isArray(content)) {
        cleaned.content = content.map((part: unknown) => {
          if (typeof part === "object" && part !== null) {
            return convertContentPart(part as Record<string, unknown>);
          }
          return part;
        });
      }

      return cleaned;
    })
    .filter((msg) => msg.content != null);
}

class OpenAICodexAdapter implements ApiAdapter {
  readonly apiType = "openai-codex-responses" as const;

  parseRequest(body: unknown): ParsedRequest {
    return parseOpenAIBody(body);
  }

  buildUpstreamRequest(
    parsed: ParsedRequest,
    targetModel: string,
    baseUrl: string,
    auth: AuthInfo,
  ): UpstreamRequest {
    const { rawBody } = parsed;

    const rawInput = rawBody.input ?? rawBody.messages ?? parsed.messages;
    const input = Array.isArray(rawInput) ? toResponsesInput(rawInput) : rawInput;
    const instructions = rawBody.instructions ?? rawBody.system ?? parsed.system ?? "You are a helpful assistant.";

    const upstreamBody: Record<string, unknown> = {
      model: targetModel,
      input,
      instructions,
      stream: true,
      store: false,
    };

    const CODEX_SAMPLING_KEYS = [
      "temperature", "top_p",
    ] as const;
    for (const key of CODEX_SAMPLING_KEYS) {
      if (key in rawBody) {
        upstreamBody[key] = rawBody[key];
      }
    }

    return {
      url: `${baseUrl}/codex/responses`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
    };
  }

  modifyMessages(
    rawBody: Record<string, unknown>,
    compressedMessages: Array<{ role: string; content: unknown }>,
  ): Record<string, unknown> {
    return openaiResponsesAdapter.modifyMessages(rawBody, compressedMessages);
  }

  parseResponse(body: unknown): ParsedResponse {
    return openaiResponsesAdapter.parseResponse(body);
  }

  buildResponse(parsed: ParsedResponse): Record<string, unknown> {
    return openaiResponsesAdapter.buildResponse(parsed);
  }

  parseStreamChunk(chunk: string): StreamEvent[] {
    return openaiResponsesAdapter.parseStreamChunk(chunk);
  }

  buildStreamChunk(event: StreamEvent): string {
    return openaiResponsesAdapter.buildStreamChunk(event);
  }
}

const openaiCodexAdapter = new OpenAICodexAdapter();
registerAdapter(openaiCodexAdapter);

export { openaiCodexAdapter, OpenAICodexAdapter };
