import type { AssistantMessageEvent, AssistantMessageEventStream } from "@mariozechner/pi-ai";

const encoder = new TextEncoder();

function sseDataFrame(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

const STATUS_MAP: Record<string, string> = {
  stop: "completed",
  length: "incomplete",
  toolUse: "completed",
  error: "failed",
  aborted: "cancelled",
};

function genId(): string {
  return "resp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

export function piStreamToOpenAiResponsesSse(
  piStream: AsyncIterable<AssistantMessageEvent>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const responseId = genId();
        let model = "";
        let created = false;
        const textBlocks = new Map<number, { outputIndex: number }>();
        let nextOutputIndex = 0;

        const ensureCreated = () => {
          if (created) return;
          created = true;
          controller.enqueue(
            sseDataFrame({
              type: "response.created",
              response: {
                id: responseId,
                object: "response",
                model,
                status: "in_progress",
              },
            }),
          );
        };

        for await (const event of piStream) {
          if (event.type === "start") {
            model = event.partial.model || model;
            ensureCreated();
          } else if (event.type === "text_start") {
            model = event.partial.model || model;
            ensureCreated();
            const outputIndex = nextOutputIndex++;
            textBlocks.set(event.contentIndex, { outputIndex });
            controller.enqueue(
              sseDataFrame({
                type: "response.output_item.added",
                output_index: outputIndex,
                item: {
                  type: "message",
                  id: `msg_${outputIndex}`,
                  role: "assistant",
                  content: [],
                },
              }),
            );
          } else if (event.type === "text_delta") {
            const block = textBlocks.get(event.contentIndex);
            const outputIndex = block?.outputIndex ?? 0;
            controller.enqueue(
              sseDataFrame({
                type: "response.output_text.delta",
                output_index: outputIndex,
                delta: event.delta,
              }),
            );
          } else if (event.type === "text_end") {
            const block = textBlocks.get(event.contentIndex);
            if (!block) continue;
            controller.enqueue(
              sseDataFrame({
                type: "response.output_text.done",
                output_index: block.outputIndex,
                text: event.content,
              }),
            );
          } else if (event.type === "thinking_delta") {
            ensureCreated();
            controller.enqueue(
              sseDataFrame({
                type: "response.reasoning_summary_text.delta",
                delta: event.delta,
              }),
            );
          } else if (event.type === "toolcall_start") {
            ensureCreated();
            const partial = event.partial.content[event.contentIndex];
            const tcId =
              partial && partial.type === "toolCall" ? partial.id : "";
            const tcName =
              partial && partial.type === "toolCall" ? partial.name : "";
            const outputIndex = nextOutputIndex++;
            textBlocks.set(event.contentIndex, { outputIndex });
            controller.enqueue(
              sseDataFrame({
                type: "response.output_item.added",
                output_index: outputIndex,
                item: {
                  type: "function_call",
                  id: tcId || `fc_${outputIndex}`,
                  call_id: tcId,
                  name: tcName,
                  arguments: "",
                },
              }),
            );
          } else if (event.type === "toolcall_delta") {
            const block = textBlocks.get(event.contentIndex);
            if (!block) continue;
            controller.enqueue(
              sseDataFrame({
                type: "response.function_call_arguments.delta",
                output_index: block.outputIndex,
                delta: event.delta,
              }),
            );
          } else if (event.type === "toolcall_end") {
            const block = textBlocks.get(event.contentIndex);
            if (!block) continue;
            controller.enqueue(
              sseDataFrame({
                type: "response.function_call_arguments.done",
                output_index: block.outputIndex,
                arguments: JSON.stringify(event.toolCall.arguments ?? {}),
              }),
            );
          } else if (event.type === "done") {
            const msg = event.message;
            model = msg.model || model;
            const status = STATUS_MAP[msg.stopReason] ?? "completed";
            const inputTokens = msg.usage?.input ?? 0;
            const outputTokens = msg.usage?.output ?? 0;
            controller.enqueue(
              sseDataFrame({
                type: "response.completed",
                response: {
                  id: responseId,
                  object: "response",
                  model,
                  status,
                  usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    total_tokens: inputTokens + outputTokens,
                  },
                },
              }),
            );
          } else if (event.type === "error") {
            const errMsg = event.error;
            controller.enqueue(
              sseDataFrame({
                type: "error",
                error: {
                  message: errMsg?.errorMessage ?? "Unknown error",
                  type: "api_error",
                },
              }),
            );
          }
        }

        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          sseDataFrame({
            type: "error",
            error: { message, type: "api_error" },
          }),
        );
        controller.close();
      }
    },
  });
}

export function openAiResponsesMessageFromAssistant(
  msg: import("@mariozechner/pi-ai").AssistantMessage,
): Record<string, unknown> {
  const output: Array<Record<string, unknown>> = [];
  for (const c of msg.content) {
    if (c.type === "text") {
      output.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: c.text }],
      });
    } else if (c.type === "thinking") {
      output.push({
        type: "reasoning",
        summary: [{ type: "summary_text", text: c.thinking }],
      });
    } else if (c.type === "toolCall") {
      output.push({
        type: "function_call",
        id: c.id,
        call_id: c.id,
        name: c.name,
        arguments: JSON.stringify(c.arguments ?? {}),
      });
    }
  }
  const status = STATUS_MAP[msg.stopReason] ?? "completed";
  const inputTokens = msg.usage?.input ?? 0;
  const outputTokens = msg.usage?.output ?? 0;
  return {
    id: genId(),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: msg.model || "",
    status,
    output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

export async function piStreamToOpenAiResponsesJson(
  piStream: AssistantMessageEventStream,
): Promise<Record<string, unknown>> {
  const msg = await piStream.result();
  return openAiResponsesMessageFromAssistant(msg);
}
