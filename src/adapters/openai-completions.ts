import type {
  ApiAdapter,
  AuthInfo,
  ParsedRequest,
  UpstreamRequest,
} from "./types.ts";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";
import { registerAdapter } from "./registry.ts";
import { parseOpenAIBody } from "./openai-shared.ts";
import { toOpenAITools } from "./tool-converter.ts";

class OpenAICompletionsAdapter implements ApiAdapter {
  readonly apiType = "openai-completions" as const;

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
    const upstreamBody: Record<string, unknown> = {
      ...rawBody,
      model: targetModel,
    };

    if (upstreamBody.tools) {
      upstreamBody.tools = toOpenAITools(upstreamBody.tools);
    }

    return {
      url: /\/v\d+\/?$/.test(baseUrl)
        ? `${baseUrl.replace(/\/$/, "")}/chat/completions`
        : `${baseUrl}/v1/chat/completions`,
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
    let stopReason: string | null = null;

    const choices = raw.choices as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(choices) && choices.length > 0) {
      const choice = choices[0];
      const message = choice.message as Record<string, unknown> | undefined;
      if (message) {
        const messageText = message.content ?? message.reasoning_content;
        if (typeof messageText === "string") {
          content = messageText;
        }
      }
      if (typeof choice.finish_reason === "string") {
        stopReason = choice.finish_reason;
      }
    }

    let usage: ParsedResponse["usage"];
    const rawUsage = raw.usage as Record<string, unknown> | undefined;
    if (rawUsage) {
      usage = {
        inputTokens:
          typeof rawUsage.prompt_tokens === "number"
            ? rawUsage.prompt_tokens
            : 0,
        outputTokens:
          typeof rawUsage.completion_tokens === "number"
            ? rawUsage.completion_tokens
            : 0,
      };
    }

    return { id, model, content, role: "assistant", stopReason, usage };
  }

  buildResponse(parsed: ParsedResponse): Record<string, unknown> {
    const result: Record<string, unknown> = {
      id: parsed.id,
      object: "chat.completion",
      model: parsed.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: parsed.content },
          finish_reason: parsed.stopReason,
        },
      ],
    };

    if (parsed.usage) {
      result.usage = {
        prompt_tokens: parsed.usage.inputTokens,
        completion_tokens: parsed.usage.outputTokens,
        total_tokens:
          parsed.usage.inputTokens + parsed.usage.outputTokens,
      };
    }

    return result;
  }

  parseStreamChunk(chunk: string): StreamEvent[] {
    const events: StreamEvent[] = [];

    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;

      const payload = trimmed.slice(6);
      if (payload === "[DONE]") {
        events.push({ type: "message_stop" });
        continue;
      }

      let data: Record<string, unknown>;
      try {
        data = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }

      const choices = data.choices as
        | Array<Record<string, unknown>>
        | undefined;
      if (!Array.isArray(choices) || choices.length === 0) {
        if (data.id && data.model) {
          events.push({
            type: "message_start",
            id: String(data.id),
            model: String(data.model),
          });
        }
        continue;
      }

      const choice = choices[0];
      const delta = choice.delta as Record<string, unknown> | undefined;
      const finishReason = choice.finish_reason;

      const textContent = delta?.content ?? delta?.reasoning_content;

      if (delta?.role === "assistant" && textContent == null) {
        events.push({
          type: "message_start",
          id: String(data.id ?? ""),
          model: String(data.model ?? ""),
        });
      } else if (typeof textContent === "string") {
        events.push({
          type: "content_delta",
          text: textContent,
          index: typeof choice.index === "number" ? choice.index : 0,
        });
      }

      if (typeof finishReason === "string" && finishReason !== "") {
        events.push({
          type: "content_stop",
          index: typeof choice.index === "number" ? choice.index : 0,
        });

        let usage: { inputTokens: number; outputTokens: number } | undefined;
        const rawUsage = data.usage as Record<string, unknown> | undefined;
        if (rawUsage) {
          usage = {
            inputTokens:
              typeof rawUsage.prompt_tokens === "number"
                ? rawUsage.prompt_tokens
                : 0,
            outputTokens:
              typeof rawUsage.completion_tokens === "number"
                ? rawUsage.completion_tokens
                : 0,
          };
        }
        events.push({ type: "message_stop", usage });
      }
    }

    return events;
  }

  buildStreamChunk(event: StreamEvent): string {
    switch (event.type) {
      case "message_start":
        return `data: ${JSON.stringify({
          id: event.id,
          object: "chat.completion.chunk",
          model: event.model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            },
          ],
        })}\n\n`;
      case "content_delta":
        return `data: ${JSON.stringify({
          id: "",
          object: "chat.completion.chunk",
          choices: [
            {
              index: event.index,
              delta: { content: event.text },
              finish_reason: null,
            },
          ],
        })}\n\n`;
      case "content_stop":
        return `data: ${JSON.stringify({
          id: "",
          object: "chat.completion.chunk",
          choices: [
            {
              index: event.index,
              delta: {},
              finish_reason: "stop",
            },
          ],
        })}\n\n`;
      case "message_stop":
        return "data: [DONE]\n\n";
      case "error":
        return `data: ${JSON.stringify({
          error: { message: event.message },
        })}\n\n`;
      default:
        return "";
    }
  }
}

const openaiCompletionsAdapter = new OpenAICompletionsAdapter();
registerAdapter(openaiCompletionsAdapter);

export { openaiCompletionsAdapter, OpenAICompletionsAdapter };
