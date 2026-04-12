import type {
  ApiAdapter,
  AuthInfo,
  ParsedRequest,
  UpstreamRequest,
} from "./types.ts";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";
import { registerAdapter } from "./registry.ts";
import { signRequest } from "../utils/aws-sigv4.ts";

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

function mapBedrockStopReason(reason: string | null): string | null {
  if (reason === null) return null;
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "max_tokens";
    case "content_filtered":
      return "content_filter";
    default:
      return reason;
  }
}

function mapStopReasonToBedrock(reason: string | null): string {
  if (reason === null) return "end_turn";
  switch (reason) {
    case "stop":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "content_filter":
      return "content_filtered";
    default:
      return reason;
  }
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

    const url = `${baseUrl}/model/${targetModel}/converse-stream`;
    const body = JSON.stringify(requestBody);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (auth.awsAccessKeyId && auth.awsSecretKey && auth.awsRegion) {
      const sigv4Headers = signRequest(
        { method: "POST", url, headers, body },
        {
          accessKeyId: auth.awsAccessKeyId,
          secretAccessKey: auth.awsSecretKey,
          sessionToken: auth.awsSessionToken,
          region: auth.awsRegion,
        },
      );
      Object.assign(headers, sigv4Headers);
    } else if (auth.apiKey) {
      headers[auth.headerName || "Authorization"] =
        auth.headerValue || auth.apiKey;
    }

    return { url, method: "POST", headers, body };
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

  parseResponse(body: unknown): ParsedResponse {
    const raw = body as Record<string, unknown>;
    const output = raw.output as { message?: Record<string, unknown> } | undefined;
    const message = output?.message as
      | { role?: string; content?: Array<{ text?: string }> }
      | undefined;

    const text =
      message?.content
        ?.filter((b) => b.text !== undefined)
        .map((b) => b.text)
        .join("") ?? "";

    const stopReason = raw.stopReason as string | undefined;
    const usage = raw.usage as
      | { inputTokens?: number; outputTokens?: number }
      | undefined;

    return {
      id: (raw.requestId as string) ?? `bedrock-${Date.now()}`,
      model: (raw.modelId as string) ?? "",
      content: text,
      role: "assistant",
      stopReason: mapBedrockStopReason(stopReason ?? null),
      usage: usage
        ? {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          }
        : undefined,
    };
  }

  buildResponse(parsed: ParsedResponse): Record<string, unknown> {
    const result: Record<string, unknown> = {
      output: {
        message: {
          role: "assistant",
          content: [{ text: parsed.content }],
        },
      },
      stopReason: mapStopReasonToBedrock(parsed.stopReason),
    };

    if (parsed.usage) {
      result.usage = {
        inputTokens: parsed.usage.inputTokens,
        outputTokens: parsed.usage.outputTokens,
      };
    }

    return result;
  }

  parseStreamChunk(chunk: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    const lines = chunk.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "") continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (parsed.messageStart !== undefined) {
        const start = parsed.messageStart as { role?: string };
        events.push({
          type: "message_start",
          id: `bedrock-${Date.now()}`,
          model: "",
        });
        void start;
      }

      if (parsed.contentBlockDelta !== undefined) {
        const delta = parsed.contentBlockDelta as {
          delta?: { text?: string };
          contentBlockIndex?: number;
        };
        events.push({
          type: "content_delta",
          text: delta.delta?.text ?? "",
          index: delta.contentBlockIndex ?? 0,
        });
      }

      if (parsed.contentBlockStop !== undefined) {
        const stop = parsed.contentBlockStop as {
          contentBlockIndex?: number;
        };
        events.push({
          type: "content_stop",
          index: stop.contentBlockIndex ?? 0,
        });
      }

      if (parsed.messageStop !== undefined) {
        const stop = parsed.messageStop as { stopReason?: string };
        events.push({
          type: "message_stop",
          usage: undefined,
        });
        void stop;
      }

      if (parsed.metadata !== undefined) {
        const meta = parsed.metadata as {
          usage?: { inputTokens?: number; outputTokens?: number };
        };
        if (meta.usage) {
          events.push({
            type: "message_stop",
            usage: {
              inputTokens: meta.usage.inputTokens ?? 0,
              outputTokens: meta.usage.outputTokens ?? 0,
            },
          });
        }
      }
    }

    return events;
  }

  buildStreamChunk(event: StreamEvent): string {
    switch (event.type) {
      case "message_start":
        return `${JSON.stringify({
          messageStart: { role: "assistant" },
        })}\n`;

      case "content_delta":
        return `${JSON.stringify({
          contentBlockDelta: {
            delta: { text: event.text },
            contentBlockIndex: event.index,
          },
        })}\n`;

      case "content_stop":
        return `${JSON.stringify({
          contentBlockStop: { contentBlockIndex: event.index },
        })}\n`;

      case "message_stop":
        if (event.usage) {
          return `${JSON.stringify({
            messageStop: { stopReason: "end_turn" },
          })}\n${JSON.stringify({
            metadata: {
              usage: {
                inputTokens: event.usage.inputTokens,
                outputTokens: event.usage.outputTokens,
              },
            },
          })}\n`;
        }
        return `${JSON.stringify({
          messageStop: { stopReason: "end_turn" },
        })}\n`;

      case "error":
        return `${JSON.stringify({
          error: { message: event.message },
        })}\n`;
    }
  }
}

const bedrockAdapter = new BedrockAdapter();
registerAdapter(bedrockAdapter);

export default bedrockAdapter;
