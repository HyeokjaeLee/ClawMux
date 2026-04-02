import type {
  ApiAdapter,
  AuthInfo,
  ParsedRequest,
  UpstreamRequest,
} from "./types.ts";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";
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

  parseResponse(body: unknown): ParsedResponse {
    const raw = body as Record<string, unknown>;
    const message = raw.message as
      | { role?: string; content?: string }
      | undefined;
    const model = (raw.model as string) ?? "";

    return {
      id: `ollama-${Date.now()}`,
      model,
      content: message?.content ?? "",
      role: "assistant",
      stopReason: raw.done === true ? "stop" : null,
      usage:
        raw.prompt_eval_count !== undefined || raw.eval_count !== undefined
          ? {
              inputTokens: (raw.prompt_eval_count as number) ?? 0,
              outputTokens: (raw.eval_count as number) ?? 0,
            }
          : undefined,
    };
  }

  buildResponse(parsed: ParsedResponse): Record<string, unknown> {
    const result: Record<string, unknown> = {
      model: parsed.model,
      message: {
        role: "assistant",
        content: parsed.content,
      },
      done: parsed.stopReason === "stop",
    };

    if (parsed.usage) {
      result.prompt_eval_count = parsed.usage.inputTokens;
      result.eval_count = parsed.usage.outputTokens;
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

      const message = parsed.message as
        | { role?: string; content?: string }
        | undefined;
      const done = parsed.done === true;

      if (message?.role === "assistant" && !done) {
        if (events.length === 0 && message.content !== undefined) {
          events.push({
            type: "message_start",
            id: `ollama-${Date.now()}`,
            model: (parsed.model as string) ?? "",
          });
        }

        if (message.content !== undefined) {
          events.push({
            type: "content_delta",
            text: message.content,
            index: 0,
          });
        }
      }

      if (done) {
        events.push({ type: "content_stop", index: 0 });
        events.push({
          type: "message_stop",
          usage:
            parsed.prompt_eval_count !== undefined ||
            parsed.eval_count !== undefined
              ? {
                  inputTokens: (parsed.prompt_eval_count as number) ?? 0,
                  outputTokens: (parsed.eval_count as number) ?? 0,
                }
              : undefined,
        });
      }
    }

    return events;
  }

  buildStreamChunk(event: StreamEvent): string {
    switch (event.type) {
      case "message_start":
        return `${JSON.stringify({
          model: event.model,
          message: { role: "assistant", content: "" },
          done: false,
        })}\n`;

      case "content_delta":
        return `${JSON.stringify({
          message: { role: "assistant", content: event.text },
          done: false,
        })}\n`;

      case "content_stop":
        return "";

      case "message_stop":
        return `${JSON.stringify({
          done: true,
          ...(event.usage
            ? {
                prompt_eval_count: event.usage.inputTokens,
                eval_count: event.usage.outputTokens,
              }
            : {}),
        })}\n`;

      case "error":
        return `${JSON.stringify({
          error: event.message,
          done: true,
        })}\n`;
    }
  }
}

const ollamaAdapter = new OllamaAdapter();
registerAdapter(ollamaAdapter);

export default ollamaAdapter;
