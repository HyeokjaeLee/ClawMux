import type { ApiAdapter, AuthInfo, ParsedRequest, UpstreamRequest } from "./types.ts";

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
    const url = `${baseUrl}/v1/messages`;

    const headers: Record<string, string> = {
      "x-api-key": auth.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };

    let bodyObj: Record<string, unknown> = {
      ...parsed.rawBody,
      model: targetModel,
    };

    const isHaiku = targetModel.toLowerCase().includes("haiku");
    const hasThinking = "thinking" in parsed.rawBody;

    if (hasThinking && !isHaiku) {
      headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
    }

    if (isHaiku && "thinking" in bodyObj) {
      const { thinking: _, ...rest } = bodyObj;
      bodyObj = rest;
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
}
