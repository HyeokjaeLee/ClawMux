import type {
  ApiAdapter,
  AuthInfo,
  ParsedRequest,
  UpstreamRequest,
} from "./types.ts";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";
import { registerAdapter } from "./registry.ts";
import { parseOpenAIBody } from "./openai-shared.ts";
import { toResponsesInput } from "./openai-responses-shared.ts";
import { toResponsesTools } from "./tool-converter.ts";

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
    const inputMessages: Array<Record<string, unknown>> = [];

    if (parsed.system !== undefined) {
      inputMessages.push({ role: "system", content: parsed.system });
    }
    inputMessages.push(...(parsed.messages as Array<Record<string, unknown>>));

    const input = toResponsesInput(inputMessages);

    const OPENAI_RESPONSES_SAMPLING_KEYS = [
      "temperature", "top_p", "truncation", "reasoning", "reasoning_effort",
      "text", "metadata", "include", "service_tier", "prompt_cache_key",
      "prompt_cache_retention", "previous_response_id", "tool_choice",
      "parallel_tool_calls",
    ] as const;

    const samplingParams: Record<string, unknown> = {};
    for (const key of OPENAI_RESPONSES_SAMPLING_KEYS) {
      if (key in parsed.rawBody) {
        samplingParams[key] = parsed.rawBody[key];
      }
    }

    const upstreamBody: Record<string, unknown> = {
      model: targetModel,
      input,
      stream: true,
      store: false,
      ...samplingParams,
    };

    if (parsed.maxTokens !== undefined) {
      upstreamBody.max_output_tokens = parsed.maxTokens;
    }

    if (parsed.rawBody.tools) {
      upstreamBody.tools = toResponsesTools(parsed.rawBody.tools);
    }

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

  parseResponse(body: unknown): ParsedResponse {
    const raw = body as Record<string, unknown>;
    const id = String(raw.id ?? "");
    const model = String(raw.model ?? "");

    let content = "";
    let stopReason: string | null = null;

    const output = raw.output as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(output)) {
      const textParts: string[] = [];
      for (const item of output) {
        if (item.type === "message") {
          const msgContent = item.content as
            | Array<Record<string, unknown>>
            | undefined;
          if (Array.isArray(msgContent)) {
            for (const part of msgContent) {
              if (
                part.type === "output_text" &&
                typeof part.text === "string"
              ) {
                textParts.push(part.text);
              }
            }
          }
        }
      }
      content = textParts.join("");
    }

    if (typeof raw.status === "string") {
      stopReason = raw.status;
    }

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
      object: "response",
      model: parsed.model,
      status: parsed.stopReason ?? "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: parsed.content },
          ],
        },
      ],
    };

    if (parsed.usage) {
      result.usage = {
        input_tokens: parsed.usage.inputTokens,
        output_tokens: parsed.usage.outputTokens,
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

      const eventType = String(data.type ?? "");

      switch (eventType) {
        case "response.created": {
          const response = data.response as
            | Record<string, unknown>
            | undefined;
          events.push({
            type: "message_start",
            id: String(response?.id ?? data.id ?? ""),
            model: String(response?.model ?? data.model ?? ""),
          });
          break;
        }
        case "response.output_text.delta": {
          events.push({
            type: "content_delta",
            text: typeof data.delta === "string" ? data.delta : "",
            index:
              typeof data.output_index === "number" ? data.output_index : 0,
          });
          break;
        }
        case "response.output_text.done": {
          events.push({
            type: "content_stop",
            index:
              typeof data.output_index === "number" ? data.output_index : 0,
          });
          break;
        }
        case "response.completed": {
          let usage:
            | { inputTokens: number; outputTokens: number }
            | undefined;
          const response = data.response as
            | Record<string, unknown>
            | undefined;
          const rawUsage = response?.usage as
            | Record<string, unknown>
            | undefined;
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
      }
    }

    return events;
  }

  buildStreamChunk(event: StreamEvent): string {
    switch (event.type) {
      case "message_start":
        return `data: ${JSON.stringify({
          type: "response.created",
          response: {
            id: event.id,
            object: "response",
            model: event.model,
            status: "in_progress",
          },
        })}\n\n`;
      case "content_delta":
        return `data: ${JSON.stringify({
          type: "response.output_text.delta",
          output_index: event.index,
          delta: event.text,
        })}\n\n`;
      case "content_stop":
        return `data: ${JSON.stringify({
          type: "response.output_text.done",
          output_index: event.index,
        })}\n\n`;
      case "message_stop":
        if (event.usage) {
          return `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              usage: {
                input_tokens: event.usage.inputTokens,
                output_tokens: event.usage.outputTokens,
              },
            },
          })}\n\n`;
        }
        return `data: ${JSON.stringify({
          type: "response.completed",
        })}\n\n`;
      case "error":
        return `data: ${JSON.stringify({
          type: "error",
          error: { message: event.message },
        })}\n\n`;
      default:
        return "";
    }
  }
}

const openaiResponsesAdapter = new OpenAIResponsesAdapter();
registerAdapter(openaiResponsesAdapter);

export { openaiResponsesAdapter, OpenAIResponsesAdapter };
