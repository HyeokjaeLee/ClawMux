import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ToolCall,
} from "@mariozechner/pi-ai";

const encoder = new TextEncoder();

function sseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const STOP_REASON_MAP: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  toolUse: "tool_use",
  error: "end_turn",
  aborted: "end_turn",
};

export function piStreamToAnthropicSse(
  piStream: AsyncIterable<AssistantMessageEvent>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let messageStarted = false;
        const openBlocks = new Map<number, "text" | "thinking" | "tool_use">();
        const toolCallMeta = new Map<
          number,
          { id: string; name: string; lastJson: string }
        >();

        const ensureMessageStart = (model: string) => {
          if (messageStarted) return;
          messageStarted = true;
          controller.enqueue(
            sseFrame("message_start", {
              type: "message_start",
              message: {
                id: "msg_" + Date.now().toString(36),
                type: "message",
                role: "assistant",
                content: [],
                model,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            }),
          );
        };

        for await (const event of piStream) {
          if (event.type === "start") {
            ensureMessageStart(event.partial.model || "");
          } else if (event.type === "text_start") {
            ensureMessageStart(event.partial.model || "");
            openBlocks.set(event.contentIndex, "text");
            controller.enqueue(
              sseFrame("content_block_start", {
                type: "content_block_start",
                index: event.contentIndex,
                content_block: { type: "text", text: "" },
              }),
            );
          } else if (event.type === "text_delta") {
            if (openBlocks.get(event.contentIndex) !== "text") {
              ensureMessageStart(event.partial.model || "");
              openBlocks.set(event.contentIndex, "text");
              controller.enqueue(
                sseFrame("content_block_start", {
                  type: "content_block_start",
                  index: event.contentIndex,
                  content_block: { type: "text", text: "" },
                }),
              );
            }
            controller.enqueue(
              sseFrame("content_block_delta", {
                type: "content_block_delta",
                index: event.contentIndex,
                delta: { type: "text_delta", text: event.delta },
              }),
            );
          } else if (event.type === "text_end") {
            if (openBlocks.get(event.contentIndex) === "text") {
              controller.enqueue(
                sseFrame("content_block_stop", {
                  type: "content_block_stop",
                  index: event.contentIndex,
                }),
              );
              openBlocks.delete(event.contentIndex);
            }
          } else if (event.type === "thinking_start") {
            ensureMessageStart(event.partial.model || "");
            openBlocks.set(event.contentIndex, "thinking");
            controller.enqueue(
              sseFrame("content_block_start", {
                type: "content_block_start",
                index: event.contentIndex,
                content_block: { type: "thinking", thinking: "" },
              }),
            );
          } else if (event.type === "thinking_delta") {
            if (openBlocks.get(event.contentIndex) !== "thinking") {
              ensureMessageStart(event.partial.model || "");
              openBlocks.set(event.contentIndex, "thinking");
              controller.enqueue(
                sseFrame("content_block_start", {
                  type: "content_block_start",
                  index: event.contentIndex,
                  content_block: { type: "thinking", thinking: "" },
                }),
              );
            }
            controller.enqueue(
              sseFrame("content_block_delta", {
                type: "content_block_delta",
                index: event.contentIndex,
                delta: { type: "thinking_delta", thinking: event.delta },
              }),
            );
          } else if (event.type === "thinking_end") {
            if (openBlocks.get(event.contentIndex) === "thinking") {
              controller.enqueue(
                sseFrame("content_block_stop", {
                  type: "content_block_stop",
                  index: event.contentIndex,
                }),
              );
              openBlocks.delete(event.contentIndex);
            }
          } else if (event.type === "toolcall_start") {
            ensureMessageStart(event.partial.model || "");
            const partial = event.partial.content[event.contentIndex];
            const id =
              partial && partial.type === "toolCall" ? partial.id : "";
            const name =
              partial && partial.type === "toolCall" ? partial.name : "";
            openBlocks.set(event.contentIndex, "tool_use");
            toolCallMeta.set(event.contentIndex, { id, name, lastJson: "" });
            controller.enqueue(
              sseFrame("content_block_start", {
                type: "content_block_start",
                index: event.contentIndex,
                content_block: {
                  type: "tool_use",
                  id,
                  name,
                  input: {},
                },
              }),
            );
          } else if (event.type === "toolcall_delta") {
            if (openBlocks.get(event.contentIndex) !== "tool_use") {
              ensureMessageStart(event.partial.model || "");
              const partial = event.partial.content[event.contentIndex];
              const id =
                partial && partial.type === "toolCall" ? partial.id : "";
              const name =
                partial && partial.type === "toolCall" ? partial.name : "";
              openBlocks.set(event.contentIndex, "tool_use");
              toolCallMeta.set(event.contentIndex, { id, name, lastJson: "" });
              controller.enqueue(
                sseFrame("content_block_start", {
                  type: "content_block_start",
                  index: event.contentIndex,
                  content_block: {
                    type: "tool_use",
                    id,
                    name,
                    input: {},
                  },
                }),
              );
            }
            const meta = toolCallMeta.get(event.contentIndex);
            const partial = event.partial.content[event.contentIndex];
            if (meta && partial && partial.type === "toolCall") {
              if (!meta.id && partial.id) meta.id = partial.id;
              if (!meta.name && partial.name) meta.name = partial.name;
            }
            controller.enqueue(
              sseFrame("content_block_delta", {
                type: "content_block_delta",
                index: event.contentIndex,
                delta: {
                  type: "input_json_delta",
                  partial_json: event.delta,
                },
              }),
            );
          } else if (event.type === "toolcall_end") {
            const meta = toolCallMeta.get(event.contentIndex);
            if (meta) {
              const tc = event.toolCall as ToolCall;
              if (tc.id) meta.id = tc.id;
              if (tc.name) meta.name = tc.name;
            }
            if (openBlocks.get(event.contentIndex) === "tool_use") {
              controller.enqueue(
                sseFrame("content_block_stop", {
                  type: "content_block_stop",
                  index: event.contentIndex,
                }),
              );
              openBlocks.delete(event.contentIndex);
            }
          } else if (event.type === "done") {
            for (const [idx] of openBlocks) {
              controller.enqueue(
                sseFrame("content_block_stop", {
                  type: "content_block_stop",
                  index: idx,
                }),
              );
            }
            openBlocks.clear();
            const msg = event.message;
            const outputTokens = msg.usage?.output ?? 0;
            controller.enqueue(
              sseFrame("message_delta", {
                type: "message_delta",
                delta: {
                  stop_reason: STOP_REASON_MAP[msg.stopReason] ?? "end_turn",
                  stop_sequence: null,
                },
                usage: { output_tokens: outputTokens },
              }),
            );
            controller.enqueue(
              sseFrame("message_stop", { type: "message_stop" }),
            );
          } else if (event.type === "error") {
            for (const [idx] of openBlocks) {
              controller.enqueue(
                sseFrame("content_block_stop", {
                  type: "content_block_stop",
                  index: idx,
                }),
              );
            }
            openBlocks.clear();
            const errMsg = event.error;
            controller.enqueue(
              sseFrame("error", {
                type: "error",
                error: {
                  type: "api_error",
                  message: errMsg?.errorMessage ?? "Unknown error",
                },
              }),
            );
          }
        }

        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          sseFrame("error", {
            type: "error",
            error: { type: "api_error", message },
          }),
        );
        controller.close();
      }
    },
  });
}

export function anthropicMessageFromAssistant(
  msg: import("@mariozechner/pi-ai").AssistantMessage,
): Record<string, unknown> {
  if (
    (msg.stopReason === "error" || msg.stopReason === "aborted") &&
    msg.errorMessage
  ) {
    console.error(
      `[clawmux] pi-ai upstream error (${msg.stopReason}): ${msg.errorMessage}`,
    );
  }
  const blocks: Array<Record<string, unknown>> = [];
  for (const c of msg.content) {
    if (c.type === "text") {
      blocks.push({ type: "text", text: c.text });
    } else if (c.type === "thinking") {
      blocks.push({
        type: "thinking",
        thinking: c.thinking,
        ...(c.thinkingSignature ? { signature: c.thinkingSignature } : {}),
      });
    } else if (c.type === "toolCall") {
      blocks.push({
        type: "tool_use",
        id: c.id,
        name: c.name,
        input: c.arguments ?? {},
      });
    }
  }
  return {
    id: "msg_" + Date.now().toString(36),
    type: "message",
    role: "assistant",
    content: blocks,
    model: msg.model || "",
    stop_reason: STOP_REASON_MAP[msg.stopReason] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: msg.usage?.input ?? 0,
      output_tokens: msg.usage?.output ?? 0,
    },
    ...(msg.errorMessage ? { error_message: msg.errorMessage } : {}),
  };
}

export async function piStreamToAnthropicJson(
  piStream: AssistantMessageEventStream,
): Promise<Record<string, unknown>> {
  const msg = await piStream.result();
  return anthropicMessageFromAssistant(msg);
}
