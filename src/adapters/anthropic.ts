import type { ApiAdapter, AuthInfo, ParsedRequest, UpstreamRequest } from "./types.ts";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";
import { toAnthropicTools } from "./tool-converter.ts";

export class AnthropicAdapter implements ApiAdapter {
  readonly apiType = "anthropic-messages" as const;

  parseRequest(body: unknown): ParsedRequest {
    const raw = body as Record<string, unknown>;

    const model = String(raw.model ?? "");
    const messages = (raw.messages ?? []) as Array<{ role: string; content: unknown }>;
    const stream = raw.stream !== false;
    const maxTokens = typeof raw.max_tokens === "number" ? raw.max_tokens : undefined;

    const system = raw.system as ParsedRequest["system"] | undefined;

    return {
      model,
      messages,
      system,
      stream,
      maxTokens,
      rawBody: raw,
    };
  }

  buildUpstreamRequest(
    parsed: ParsedRequest,
    targetModel: string,
    baseUrl: string,
    auth: AuthInfo,
  ): UpstreamRequest {
    const url = `${baseUrl.replace(/\/+$/, "")}/v1/messages`;

    const isOAuthToken = typeof auth.apiKey === "string" && auth.apiKey.includes("sk-ant-oat");
    const isHaiku = targetModel.toLowerCase().includes("haiku");
    const hasThinking = "thinking" in parsed.rawBody;

    const betaFeatures: string[] = ["fine-grained-tool-streaming-2025-05-14"];
    if (hasThinking && !isHaiku) {
      betaFeatures.push("interleaved-thinking-2025-05-14");
    }
    const claudeCodeBetas = isOAuthToken
      ? ["claude-code-20250219", "oauth-2025-04-20"]
      : [];
    const allBetas = [...claudeCodeBetas, ...betaFeatures];

    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "accept": "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": allBetas.join(","),
    };

    if (isOAuthToken) {
      headers["Authorization"] = `Bearer ${auth.apiKey}`;
      headers["user-agent"] = "claude-cli/1.0.0 (external, cli)";
      headers["x-app"] = "cli";
    } else {
      headers["x-api-key"] = auth.apiKey;
    }

    const ANTHROPIC_SAMPLING_KEYS = [
      "temperature", "top_p", "top_k", "stop_sequences",
      "metadata", "service_tier", "tool_choice",
    ] as const;

    const samplingParams: Record<string, unknown> = {};
    for (const key of ANTHROPIC_SAMPLING_KEYS) {
      if (key in parsed.rawBody) {
        samplingParams[key] = parsed.rawBody[key];
      }
    }

    const bodyObj: Record<string, unknown> = {
      model: targetModel,
      messages: parsed.messages,
      stream: true,
      ...samplingParams,
    };

    if (parsed.system !== undefined) {
      bodyObj.system = parsed.system;
    } else if (isOAuthToken) {
      bodyObj.system = [
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
        },
      ];
    }

    if (parsed.maxTokens !== undefined) {
      bodyObj.max_tokens = parsed.maxTokens;
    } else {
      bodyObj.max_tokens = 32000;
    }

    if (parsed.rawBody.tools) {
      bodyObj.tools = toAnthropicTools(parsed.rawBody.tools);
    }

    if (!isHaiku && hasThinking) {
      bodyObj.thinking = parsed.rawBody.thinking;
    }

    return {
      url,
      method: "POST",
      headers,
      body: JSON.stringify(bodyObj),
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

  parseResponse(body: unknown): ParsedResponse {
    const raw = body as Record<string, unknown>;
    const id = String(raw.id ?? "");
    const model = String(raw.model ?? "");

    let content = "";
    const contentBlocks = raw.content;
    if (Array.isArray(contentBlocks)) {
      const textParts: string[] = [];
      for (const block of contentBlocks) {
        if (
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          textParts.push((block as Record<string, unknown>).text as string);
        }
      }
      content = textParts.join("");
    }

    const stopReason =
      typeof raw.stop_reason === "string" ? raw.stop_reason : null;

    let usage: ParsedResponse["usage"];
    const rawUsage = raw.usage as Record<string, unknown> | undefined;
    if (rawUsage) {
      usage = {
        inputTokens:
          typeof rawUsage.input_tokens === "number"
            ? rawUsage.input_tokens
            : 0,
        outputTokens:
          typeof rawUsage.output_tokens === "number"
            ? rawUsage.output_tokens
            : 0,
      };
    }

    return { id, model, content, role: "assistant", stopReason, usage };
  }

  buildResponse(parsed: ParsedResponse): Record<string, unknown> {
    const result: Record<string, unknown> = {
      id: parsed.id,
      type: "message",
      role: "assistant",
      model: parsed.model,
      content: [{ type: "text", text: parsed.content }],
      stop_reason: parsed.stopReason,
    };

    if (parsed.usage) {
      result.usage = {
        input_tokens: parsed.usage.inputTokens,
        output_tokens: parsed.usage.outputTokens,
      };
    }

    return result;
  }

  parseStreamChunk(chunk: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    let eventType = "";
    let dataStr = "";

    for (const line of chunk.split("\n")) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        dataStr = line.slice(6);
      }
    }

    if (!eventType && !dataStr) return events;

    // Ignore ping and content_block_start
    if (eventType === "ping" || eventType === "content_block_start") {
      return events;
    }

    let data: Record<string, unknown> = {};
    if (dataStr) {
      try {
        data = JSON.parse(dataStr) as Record<string, unknown>;
      } catch {
        return events;
      }
    }

    switch (eventType) {
      case "message_start": {
        const message = data.message as Record<string, unknown> | undefined;
        events.push({
          type: "message_start",
          id: String(message?.id ?? data.id ?? ""),
          model: String(message?.model ?? data.model ?? ""),
        });
        break;
      }
      case "content_block_delta": {
        const delta = data.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          events.push({
            type: "content_delta",
            text: delta.text,
            index: typeof data.index === "number" ? data.index : 0,
          });
        }
        break;
      }
      case "content_block_stop": {
        events.push({
          type: "content_stop",
          index: typeof data.index === "number" ? data.index : 0,
        });
        break;
      }
      case "message_delta": {
        const rawUsage = data.usage as Record<string, unknown> | undefined;
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        if (rawUsage) {
          usage = {
            inputTokens:
              typeof rawUsage.input_tokens === "number"
                ? rawUsage.input_tokens
                : 0,
            outputTokens:
              typeof rawUsage.output_tokens === "number"
                ? rawUsage.output_tokens
                : 0,
          };
        }
        events.push({ type: "message_stop", usage });
        break;
      }
      case "message_stop": {
        events.push({ type: "message_stop" });
        break;
      }
    }

    return events;
  }

  buildStreamChunk(event: StreamEvent): string {
    switch (event.type) {
      case "message_start":
        return (
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: event.id,
              type: "message",
              role: "assistant",
              model: event.model,
            },
          })}\n\n`
        );
      case "content_delta":
        return (
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: event.index,
            delta: { type: "text_delta", text: event.text },
          })}\n\n`
        );
      case "content_stop":
        return (
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: event.index,
          })}\n\n`
        );
      case "message_stop":
        if (event.usage) {
          return (
            `event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              usage: {
                input_tokens: event.usage.inputTokens,
                output_tokens: event.usage.outputTokens,
              },
            })}\n\n` +
            `event: message_stop\ndata: ${JSON.stringify({
              type: "message_stop",
            })}\n\n`
          );
        }
        return (
          `event: message_stop\ndata: ${JSON.stringify({
            type: "message_stop",
          })}\n\n`
        );
      case "error":
        return (
          `event: error\ndata: ${JSON.stringify({
            type: "error",
            error: { message: event.message },
          })}\n\n`
        );
      default:
        return "";
    }
  }
}
