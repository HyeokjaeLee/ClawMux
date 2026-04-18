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
import { toResponsesInput } from "./openai-responses-shared.ts";
import { toCodexResponsesTools } from "./tool-converter.ts";
import * as os from "node:os";

function resolveCodexUrl(baseUrl: string): string {
  const DEFAULT = "https://chatgpt.com/backend-api";
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function buildPiUserAgent(): string {
  try {
    return `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
  } catch {
    return "pi (browser)";
  }
}

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

    const rawInput = rawBody.input ?? rawBody.messages ?? parsed.messages;
    const input = Array.isArray(rawInput) ? toResponsesInput(rawInput) : rawInput;
    const instructions = rawBody.instructions ?? rawBody.system ?? parsed.system ?? "You are a helpful assistant.";

    const verbosity = (
      rawBody.text && typeof rawBody.text === "object"
        ? (rawBody.text as Record<string, unknown>).verbosity
        : undefined
    ) ?? rawBody.text_verbosity ?? rawBody.verbosity ?? "medium";

    const sessionId = (rawBody.session_id ?? rawBody.sessionId ?? rawBody.prompt_cache_key) as string | undefined;

    const upstreamBody: Record<string, unknown> = {
      model: targetModel,
      store: false,
      stream: true,
      instructions,
      input,
      text: { verbosity },
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      parallel_tool_calls: true,
    };

    if (sessionId) {
      upstreamBody.prompt_cache_key = sessionId;
    }

    if (typeof rawBody.temperature === "number") {
      upstreamBody.temperature = rawBody.temperature;
    }

    if (Array.isArray(rawBody.tools) && rawBody.tools.length > 0) {
      upstreamBody.tools = toCodexResponsesTools(rawBody.tools);
    }

    if (rawBody.reasoning && typeof rawBody.reasoning === "object") {
      upstreamBody.reasoning = rawBody.reasoning;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.apiKey}`,
      "chatgpt-account-id": auth.accountId ?? "",
      "OpenAI-Beta": "responses=experimental",
      "originator": "pi",
      "User-Agent": buildPiUserAgent(),
      "accept": "text/event-stream",
    };

    if (sessionId) {
      headers["session_id"] = sessionId;
    }

    return {
      url: resolveCodexUrl(baseUrl),
      method: "POST",
      headers,
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
