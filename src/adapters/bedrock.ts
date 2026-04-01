import type {
  ApiAdapter,
  AuthInfo,
  ParsedRequest,
  UpstreamRequest,
} from "./types.ts";
import { registerAdapter } from "./registry.ts";

interface BedrockContentBlock {
  text?: string;
  image?: { format: string; source: { bytes: string } };
}

interface BedrockMessage {
  role: string;
  content: BedrockContentBlock[] | string;
}

interface BedrockRequestBody {
  modelId?: string;
  messages?: BedrockMessage[];
  system?: Array<{ text: string }>;
  inferenceConfig?: {
    maxTokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function bedrockMessagesToStandard(
  messages: BedrockMessage[],
): Array<{ role: string; content: unknown }> {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return { role: m.role, content: m.content };
    }
    const textParts = m.content.filter((b) => b.text !== undefined);
    if (textParts.length === 1) {
      return { role: m.role, content: textParts[0].text };
    }
    return { role: m.role, content: m.content };
  });
}

function standardMessagesToBedrock(
  messages: Array<{ role: string; content: unknown }>,
): BedrockMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return { role: m.role, content: [{ text: m.content }] };
    }
    if (Array.isArray(m.content)) {
      return { role: m.role, content: m.content as BedrockContentBlock[] };
    }
    return { role: m.role, content: [{ text: String(m.content) }] };
  });
}

export class BedrockAdapter implements ApiAdapter {
  readonly apiType = "bedrock-converse-stream" as const;

  parseRequest(body: unknown): ParsedRequest {
    const raw = body as BedrockRequestBody;
    const model = raw.modelId ?? "";
    const messages = raw.messages
      ? bedrockMessagesToStandard(raw.messages)
      : [];

    let system: string | Array<{ type: string; text: string }> | undefined;
    if (raw.system && raw.system.length > 0) {
      if (raw.system.length === 1) {
        system = raw.system[0].text;
      } else {
        system = raw.system.map((s) => ({ type: "text", text: s.text }));
      }
    }

    return {
      model,
      messages,
      system,
      stream: true,
      maxTokens: raw.inferenceConfig?.maxTokens,
      rawBody: raw as Record<string, unknown>,
    };
  }

  buildUpstreamRequest(
    parsed: ParsedRequest,
    targetModel: string,
    baseUrl: string,
    auth: AuthInfo,
  ): UpstreamRequest {
    const bedrockMessages = standardMessagesToBedrock(parsed.messages);

    const requestBody: Record<string, unknown> = {
      ...parsed.rawBody,
      messages: bedrockMessages,
    };

    delete requestBody.modelId;

    if (parsed.system) {
      if (typeof parsed.system === "string") {
        requestBody.system = [{ text: parsed.system }];
      } else {
        requestBody.system = parsed.system.map((s) => ({ text: s.text }));
      }
    }

    if (parsed.maxTokens !== undefined) {
      requestBody.inferenceConfig = {
        ...(requestBody.inferenceConfig as Record<string, unknown> | undefined),
        maxTokens: parsed.maxTokens,
      };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (auth.apiKey) {
      headers[auth.headerName || "Authorization"] =
        auth.headerValue || auth.apiKey;
    }

    return {
      url: `${baseUrl}/model/${targetModel}/converse-stream`,
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    };
  }

  modifyMessages(
    rawBody: Record<string, unknown>,
    compressedMessages: Array<{ role: string; content: unknown }>,
  ): Record<string, unknown> {
    return {
      ...rawBody,
      messages: standardMessagesToBedrock(compressedMessages),
    };
  }
}

const bedrockAdapter = new BedrockAdapter();
registerAdapter(bedrockAdapter);

export default bedrockAdapter;
