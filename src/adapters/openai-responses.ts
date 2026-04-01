import type {
  ApiAdapter,
  AuthInfo,
  ParsedRequest,
  UpstreamRequest,
} from "./types.ts";
import { registerAdapter } from "./registry.ts";
import { parseOpenAIBody } from "./openai-shared.ts";

class OpenAIResponsesAdapter implements ApiAdapter {
  readonly apiType = "openai-responses" as const;

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
    const upstreamBody = {
      ...rawBody,
      model: targetModel,
    };

    return {
      url: `${baseUrl}/v1/responses`,
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
    const hasInput = "input" in rawBody;
    const fieldName = hasInput ? "input" : "messages";

    return {
      ...rawBody,
      [fieldName]: compressedMessages,
    };
  }
}

const openaiResponsesAdapter = new OpenAIResponsesAdapter();
registerAdapter(openaiResponsesAdapter);

export { openaiResponsesAdapter, OpenAIResponsesAdapter };
