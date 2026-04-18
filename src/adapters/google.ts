import type {
  ApiAdapter,
  AuthInfo,
  ParsedRequest,
  UpstreamRequest,
} from "./types.ts";
import type { ParsedResponse, StreamEvent } from "./response-types.ts";
import { registerAdapter } from "./registry.ts";

interface GooglePart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GoogleContent {
  role?: string;
  parts: GooglePart[];
}

interface GoogleRequestBody {
  model?: string;
  contents?: GoogleContent[];
  systemInstruction?: { parts: GooglePart[] };
  generationConfig?: {
    maxOutputTokens?: number;
    [key: string]: unknown;
  };
  stream?: boolean;
  [key: string]: unknown;
}

function googleRoleToStandard(role: string | undefined): string {
  if (role === "model") return "assistant";
  return role ?? "user";
}

function standardRoleToGoogle(role: string): string {
  if (role === "assistant") return "model";
  return "user";
}

function contentsToMessages(
  contents: GoogleContent[],
): Array<{ role: string; content: unknown }> {
  return contents.map((c) => {
    const text = c.parts
      .filter((p) => p.text !== undefined)
      .map((p) => p.text)
      .join("");
    return {
      role: googleRoleToStandard(c.role),
      content: text || c.parts,
    };
  });
}

function messagesToContents(
  messages: Array<{ role: string; content: unknown }>,
): GoogleContent[] {
  return messages.map((m) => ({
    role: standardRoleToGoogle(m.role),
    parts:
      typeof m.content === "string"
        ? [{ text: m.content }]
        : Array.isArray(m.content)
          ? (m.content as GooglePart[])
          : [{ text: String(m.content) }],
  }));
}

function mapGoogleFinishReason(reason: string | null): string | null {
  if (reason === null) return null;
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
      return "content_filter";
    default:
      return reason.toLowerCase();
  }
}

function mapStopReasonToGoogle(reason: string | null): string {
  if (reason === null) return "STOP";
  switch (reason) {
    case "stop":
      return "STOP";
    case "max_tokens":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    default:
      return reason.toUpperCase();
  }
}

export class GoogleGenerativeAIAdapter implements ApiAdapter {
  readonly apiType = "google-generative-ai" as const;

  parseRequest(body: unknown): ParsedRequest {
    const raw = body as GoogleRequestBody;
    const model = raw.model ?? "";
    const contents = raw.contents ?? [];
    const messages = contentsToMessages(contents);

    let system: string | undefined;
    if (raw.systemInstruction?.parts) {
      system = raw.systemInstruction.parts
        .filter((p) => p.text !== undefined)
        .map((p) => p.text)
        .join("");
    }

    return {
      model,
      messages,
      system,
      stream: raw.stream !== false,
      maxTokens: raw.generationConfig?.maxOutputTokens,
      rawBody: raw as Record<string, unknown>,
    };
  }

  buildUpstreamRequest(
    parsed: ParsedRequest,
    targetModel: string,
    baseUrl: string,
    auth: AuthInfo,
  ): UpstreamRequest {
    const normalizedBase = baseUrl.replace(/\/+$/, "");
    const endpoint = parsed.stream
      ? `${normalizedBase}/v1beta/models/${targetModel}:streamGenerateContent?alt=sse`
      : `${normalizedBase}/v1beta/models/${targetModel}:generateContent`;

    const contents = messagesToContents(parsed.messages);

    const requestBody: Record<string, unknown> = {
      ...parsed.rawBody,
      contents,
    };

    delete requestBody.model;
    delete requestBody.stream;

    if (parsed.system) {
      requestBody.systemInstruction = {
        parts: [{ text: parsed.system }],
      };
    }

    if (parsed.maxTokens !== undefined) {
      requestBody.generationConfig = {
        ...(requestBody.generationConfig as Record<string, unknown> | undefined),
        maxOutputTokens: parsed.maxTokens,
      };
    }

    return {
      url: endpoint,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [auth.headerName || "x-goog-api-key"]: auth.headerValue || auth.apiKey,
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
      contents: messagesToContents(compressedMessages),
    };
  }

  parseResponse(body: unknown): ParsedResponse {
    const raw = body as Record<string, unknown>;
    const candidates = raw.candidates as
      | Array<Record<string, unknown>>
      | undefined;
    const candidate = candidates?.[0];
    const content = candidate?.content as
      | { parts?: Array<{ text?: string }>; role?: string }
      | undefined;
    const text =
      content?.parts
        ?.filter((p) => p.text !== undefined)
        .map((p) => p.text)
        .join("") ?? "";

    const finishReason = candidate?.finishReason as string | undefined;
    const usageMeta = raw.usageMetadata as
      | { promptTokenCount?: number; candidatesTokenCount?: number }
      | undefined;

    return {
      id: (raw.id as string) ?? `google-${Date.now()}`,
      model: (raw.modelVersion as string) ?? "",
      content: text,
      role: "assistant",
      stopReason: mapGoogleFinishReason(finishReason ?? null),
      usage: usageMeta
        ? {
            inputTokens: usageMeta.promptTokenCount ?? 0,
            outputTokens: usageMeta.candidatesTokenCount ?? 0,
          }
        : undefined,
    };
  }

  buildResponse(parsed: ParsedResponse): Record<string, unknown> {
    const result: Record<string, unknown> = {
      candidates: [
        {
          content: {
            parts: [{ text: parsed.content }],
            role: "model",
          },
          finishReason: mapStopReasonToGoogle(parsed.stopReason),
        },
      ],
    };

    if (parsed.usage) {
      result.usageMetadata = {
        promptTokenCount: parsed.usage.inputTokens,
        candidatesTokenCount: parsed.usage.outputTokens,
      };
    }

    return result;
  }

  parseStreamChunk(chunk: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    const lines = chunk.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr === "" || jsonStr === "[DONE]") continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      } catch {
        continue;
      }

      const candidates = parsed.candidates as
        | Array<Record<string, unknown>>
        | undefined;
      const candidate = candidates?.[0];

      if (!candidate) continue;

      const content = candidate.content as
        | { parts?: Array<{ text?: string }>; role?: string }
        | undefined;
      const text =
        content?.parts
          ?.filter((p) => p.text !== undefined)
          .map((p) => p.text)
          .join("") ?? "";
      const finishReason = candidate.finishReason as string | undefined;

      if (content?.role === "model" && text !== "") {
        events.push({
          type: "message_start",
          id: (parsed.id as string) ?? `google-${Date.now()}`,
          model: (parsed.modelVersion as string) ?? "",
        });
        events.push({ type: "content_delta", text, index: 0 });
      } else if (text !== "") {
        events.push({ type: "content_delta", text, index: 0 });
      }

      if (finishReason && finishReason !== "FINISH_REASON_UNSPECIFIED") {
        const usageMeta = parsed.usageMetadata as
          | { promptTokenCount?: number; candidatesTokenCount?: number }
          | undefined;
        events.push({ type: "content_stop", index: 0 });
        events.push({
          type: "message_stop",
          usage: usageMeta
            ? {
                inputTokens: usageMeta.promptTokenCount ?? 0,
                outputTokens: usageMeta.candidatesTokenCount ?? 0,
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
        return `data: ${JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "" }], role: "model" },
            },
          ],
        })}\n\n`;

      case "content_delta":
        return `data: ${JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: event.text }], role: "model" },
            },
          ],
        })}\n\n`;

      case "content_stop":
        return "";

      case "message_stop":
        return `data: ${JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "" }], role: "model" },
              finishReason: "STOP",
            },
          ],
          ...(event.usage
            ? {
                usageMetadata: {
                  promptTokenCount: event.usage.inputTokens,
                  candidatesTokenCount: event.usage.outputTokens,
                },
              }
            : {}),
        })}\n\n`;

      case "error":
        return `data: ${JSON.stringify({
          error: { message: event.message },
        })}\n\n`;
    }
  }
}

const googleAdapter = new GoogleGenerativeAIAdapter();
registerAdapter(googleAdapter);

export default googleAdapter;
