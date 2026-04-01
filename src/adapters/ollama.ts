import type {
  ApiAdapter,
  AuthInfo,
  ParsedRequest,
  UpstreamRequest,
} from "./types.ts";
import { registerAdapter } from "./registry.ts";

interface OllamaRequestBody {
  model?: string;
  messages?: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  options?: {
    num_predict?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export class OllamaAdapter implements ApiAdapter {
  readonly apiType = "ollama" as const;

  parseRequest(body: unknown): ParsedRequest {
    const raw = body as OllamaRequestBody;
    const model = raw.model ?? "";
    const messages = raw.messages ?? [];
    const stream = raw.stream !== false;

    let system: string | undefined;
    const filteredMessages: Array<{ role: string; content: unknown }> = [];
    for (const msg of messages) {
      if (msg.role === "system" && typeof msg.content === "string") {
        system = msg.content;
      } else {
        filteredMessages.push(msg);
      }
    }

    return {
      model,
      messages: filteredMessages,
      system,
      stream,
      maxTokens: raw.options?.num_predict,
      rawBody: raw as Record<string, unknown>,
    };
  }

  buildUpstreamRequest(
    parsed: ParsedRequest,
    targetModel: string,
    baseUrl: string,
    _auth: AuthInfo,
  ): UpstreamRequest {
    const messages: Array<{ role: string; content: unknown }> = [];

    if (parsed.system) {
      messages.push({ role: "system", content: parsed.system });
    }
    messages.push(...parsed.messages);

    const requestBody: Record<string, unknown> = {
      ...parsed.rawBody,
      model: targetModel,
      messages,
      stream: parsed.stream,
    };

    if (parsed.maxTokens !== undefined) {
      requestBody.options = {
        ...(requestBody.options as Record<string, unknown> | undefined),
        num_predict: parsed.maxTokens,
      };
    }

    return {
      url: `${baseUrl}/api/chat`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    };
  }

  modifyMessages(
    rawBody: Record<string, unknown>,
    compressedMessages: Array<{ role: string; content: unknown }>,
  ): Record<string, unknown> {
    return {
      ...rawBody,
      messages: compressedMessages,
    };
  }
}

const ollamaAdapter = new OllamaAdapter();
registerAdapter(ollamaAdapter);

export default ollamaAdapter;
