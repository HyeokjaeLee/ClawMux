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

    const upstreamBody: Record<string, unknown> = { ...rawBody };
    upstreamBody.model = targetModel;
    upstreamBody.stream = true;
    upstreamBody.store = false;

    if (!upstreamBody.instructions) {
      upstreamBody.instructions = upstreamBody.system ?? "You are a helpful assistant.";
    }
    delete upstreamBody.system;

    if (!upstreamBody.input && upstreamBody.messages) {
      upstreamBody.input = upstreamBody.messages;
      delete upstreamBody.messages;
    }

    delete upstreamBody.max_tokens;
    delete upstreamBody.max_output_tokens;

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
