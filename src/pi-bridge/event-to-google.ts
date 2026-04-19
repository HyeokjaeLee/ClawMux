import type { AssistantMessageEvent, AssistantMessageEventStream } from "@mariozechner/pi-ai";

const encoder = new TextEncoder();

function sseDataFrame(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

const FINISH_REASON_MAP: Record<string, string> = {
  stop: "STOP",
  length: "MAX_TOKENS",
  toolUse: "STOP",
  error: "OTHER",
  aborted: "OTHER",
};

export function piStreamToGoogleSse(
  piStream: AsyncIterable<AssistantMessageEvent>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let model = "";
        const pendingToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

        for await (const event of piStream) {
          if (event.type === "start") {
            model = event.partial.model || model;
          } else if (event.type === "text_delta") {
            controller.enqueue(
              sseDataFrame({
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [{ text: event.delta }],
                    },
                    index: 0,
                  },
                ],
                modelVersion: model,
              }),
            );
          } else if (event.type === "thinking_delta") {
            controller.enqueue(
              sseDataFrame({
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [{ text: event.delta, thought: true }],
                    },
                    index: 0,
                  },
                ],
                modelVersion: model,
              }),
            );
          } else if (event.type === "toolcall_end") {
            pendingToolCalls.push({
              name: event.toolCall.name,
              args: event.toolCall.arguments ?? {},
            });
            controller.enqueue(
              sseDataFrame({
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [
                        {
                          functionCall: {
                            name: event.toolCall.name,
                            args: event.toolCall.arguments ?? {},
                          },
                        },
                      ],
                    },
                    index: 0,
                  },
                ],
                modelVersion: model,
              }),
            );
          } else if (event.type === "done") {
            const msg = event.message;
            model = msg.model || model;
            const finishReason = FINISH_REASON_MAP[msg.stopReason] ?? "STOP";
            const inputTokens = msg.usage?.input ?? 0;
            const outputTokens = msg.usage?.output ?? 0;
            controller.enqueue(
              sseDataFrame({
                candidates: [
                  {
                    content: { role: "model", parts: [{ text: "" }] },
                    finishReason,
                    index: 0,
                  },
                ],
                usageMetadata: {
                  promptTokenCount: inputTokens,
                  candidatesTokenCount: outputTokens,
                  totalTokenCount: inputTokens + outputTokens,
                },
                modelVersion: model,
              }),
            );
          } else if (event.type === "error") {
            const errMsg = event.error;
            controller.enqueue(
              sseDataFrame({
                error: {
                  message: errMsg?.errorMessage ?? "Unknown error",
                  status: "INTERNAL",
                },
              }),
            );
          }
        }

        void pendingToolCalls;
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          sseDataFrame({
            error: { message, status: "INTERNAL" },
          }),
        );
        controller.close();
      }
    },
  });
}

export function googleMessageFromAssistant(
  msg: import("@mariozechner/pi-ai").AssistantMessage,
): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];
  for (const c of msg.content) {
    if (c.type === "text") {
      parts.push({ text: c.text });
    } else if (c.type === "thinking") {
      parts.push({ text: c.thinking, thought: true });
    } else if (c.type === "toolCall") {
      parts.push({
        functionCall: { name: c.name, args: c.arguments ?? {} },
      });
    }
  }
  const finishReason = FINISH_REASON_MAP[msg.stopReason] ?? "STOP";
  const inputTokens = msg.usage?.input ?? 0;
  const outputTokens = msg.usage?.output ?? 0;
  return {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason,
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: inputTokens,
      candidatesTokenCount: outputTokens,
      totalTokenCount: inputTokens + outputTokens,
    },
    modelVersion: msg.model || "",
  };
}

export async function piStreamToGoogleJson(
  piStream: AssistantMessageEventStream,
): Promise<Record<string, unknown>> {
  const msg = await piStream.result();
  return googleMessageFromAssistant(msg);
}
