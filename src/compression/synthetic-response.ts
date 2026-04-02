import type { ParsedResponse } from "../adapters/response-types.ts";
import { estimateTokens } from "../utils/token-estimator.ts";

function messageContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block: Record<string, unknown>) =>
          block.type === "text" && typeof block.text === "string",
      )
      .map((block: Record<string, unknown>) => block.text as string)
      .join("\n");
  }
  return JSON.stringify(content);
}

function formatRecentMessages(
  messages: ReadonlyArray<{ role: string; content: unknown }>,
): string {
  return messages
    .map((m) => `[${m.role}]: ${messageContentToString(m.content)}`)
    .join("\n\n");
}

export function buildSyntheticSummaryResponse(
  summary: string,
  recentMessages: ReadonlyArray<{ role: string; content: unknown }>,
  model: string,
): ParsedResponse {
  const recentText = formatRecentMessages(recentMessages);
  const content = `<summary>\n${summary}\n</summary>\n\n<recent_messages>\n${recentText}\n</recent_messages>`;

  return {
    id: `msg_precomputed_${Date.now()}`,
    model,
    content,
    role: "assistant",
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: estimateTokens(content) },
  };
}

interface ResponseBuilder {
  buildResponse?(parsed: ParsedResponse): Record<string, unknown>;
}

export function buildSyntheticHttpResponse(
  parsed: ParsedResponse,
  adapter: ResponseBuilder,
): Response {
  const body = adapter.buildResponse
    ? adapter.buildResponse(parsed)
    : {
        id: parsed.id,
        type: "message",
        role: "assistant",
        model: parsed.model,
        content: [{ type: "text", text: parsed.content }],
        stop_reason: parsed.stopReason,
        usage: parsed.usage
          ? {
              input_tokens: parsed.usage.inputTokens,
              output_tokens: parsed.usage.outputTokens,
            }
          : undefined,
      };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-synthetic-response": "true",
    },
  });
}
