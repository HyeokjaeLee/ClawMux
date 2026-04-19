import type { AssistantMessageEvent, AssistantMessageEventStream } from "@mariozechner/pi-ai";

const encoder = new TextEncoder();

function sseDataFrame(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

const DONE_FRAME = encoder.encode(`data: [DONE]\n\n`);

const FINISH_REASON_MAP: Record<string, string> = {
  stop: "stop",
  length: "length",
  toolUse: "tool_calls",
  error: "stop",
  aborted: "stop",
};

function genId(): string {
  return "chatcmpl-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

interface ToolCallState {
  index: number;
  id: string;
  name: string;
  emittedName: boolean;
}

export function piStreamToOpenAiCompletionsSse(
  piStream: AsyncIterable<AssistantMessageEvent>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const id = genId();
        let model = "";
        let role = "assistant";
        let chunkStarted = false;
        const toolCallStates = new Map<number, ToolCallState>();
        const toolCallOrder = new Map<number, number>();
        let nextToolIndex = 0;

        const emitRoleChunk = () => {
          if (chunkStarted) return;
          chunkStarted = true;
          controller.enqueue(
            sseDataFrame({
              id,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: { role },
                  finish_reason: null,
                },
              ],
            }),
          );
        };

        for await (const event of piStream) {
          if (event.type === "start") {
            model = event.partial.model || model;
            emitRoleChunk();
          } else if (event.type === "text_start") {
            model = event.partial.model || model;
            emitRoleChunk();
          } else if (event.type === "text_delta") {
            emitRoleChunk();
            controller.enqueue(
              sseDataFrame({
                id,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: event.delta },
                    finish_reason: null,
                  },
                ],
              }),
            );
          } else if (event.type === "thinking_delta") {
            emitRoleChunk();
            controller.enqueue(
              sseDataFrame({
                id,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: { reasoning_content: event.delta },
                    finish_reason: null,
                  },
                ],
              }),
            );
          } else if (event.type === "toolcall_start") {
            emitRoleChunk();
            const partial = event.partial.content[event.contentIndex];
            const tcId =
              partial && partial.type === "toolCall" ? partial.id : "";
            const tcName =
              partial && partial.type === "toolCall" ? partial.name : "";
            const toolIdx = nextToolIndex++;
            toolCallOrder.set(event.contentIndex, toolIdx);
            toolCallStates.set(event.contentIndex, {
              index: toolIdx,
              id: tcId,
              name: tcName,
              emittedName: false,
            });
            if (tcId || tcName) {
              toolCallStates.get(event.contentIndex)!.emittedName = true;
              controller.enqueue(
                sseDataFrame({
                  id,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: toolIdx,
                            id: tcId || undefined,
                            type: "function",
                            function: { name: tcName || undefined, arguments: "" },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                }),
              );
            }
          } else if (event.type === "toolcall_delta") {
            const state = toolCallStates.get(event.contentIndex);
            if (!state) continue;
            const partial = event.partial.content[event.contentIndex];
            if (
              partial &&
              partial.type === "toolCall" &&
              !state.emittedName &&
              (partial.id || partial.name)
            ) {
              state.id = partial.id || state.id;
              state.name = partial.name || state.name;
              state.emittedName = true;
              controller.enqueue(
                sseDataFrame({
                  id,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: state.index,
                            id: state.id || undefined,
                            type: "function",
                            function: { name: state.name || undefined, arguments: "" },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                }),
              );
            }
            controller.enqueue(
              sseDataFrame({
                id,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: state.index,
                          function: { arguments: event.delta },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              }),
            );
          } else if (event.type === "done") {
            const msg = event.message;
            model = msg.model || model;
            role = "assistant";
            const finishReason = FINISH_REASON_MAP[msg.stopReason] ?? "stop";
            const inputTokens = msg.usage?.input ?? 0;
            const outputTokens = msg.usage?.output ?? 0;
            controller.enqueue(
              sseDataFrame({
                id,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: finishReason,
                  },
                ],
                usage: {
                  prompt_tokens: inputTokens,
                  completion_tokens: outputTokens,
                  total_tokens: inputTokens + outputTokens,
                },
              }),
            );
          } else if (event.type === "error") {
            const errMsg = event.error;
            controller.enqueue(
              sseDataFrame({
                error: {
                  message: errMsg?.errorMessage ?? "Unknown error",
                  type: "api_error",
                },
              }),
            );
          }
        }

        controller.enqueue(DONE_FRAME);
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          sseDataFrame({ error: { message, type: "api_error" } }),
        );
        controller.enqueue(DONE_FRAME);
        controller.close();
      }
    },
  });
}

export function openAiCompletionsMessageFromAssistant(
  msg: import("@mariozechner/pi-ai").AssistantMessage,
): Record<string, unknown> {
  let textContent = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  let reasoning = "";
  for (const c of msg.content) {
    if (c.type === "text") {
      textContent += c.text;
    } else if (c.type === "thinking") {
      reasoning += c.thinking;
    } else if (c.type === "toolCall") {
      toolCalls.push({
        id: c.id,
        type: "function",
        function: {
          name: c.name,
          arguments: JSON.stringify(c.arguments ?? {}),
        },
      });
    }
  }
  const finishReason = FINISH_REASON_MAP[msg.stopReason] ?? "stop";
  const inputTokens = msg.usage?.input ?? 0;
  const outputTokens = msg.usage?.output ?? 0;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: textContent || null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id: genId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: msg.model || "",
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    },
  };
}

export async function piStreamToOpenAiCompletionsJson(
  piStream: AssistantMessageEventStream,
): Promise<Record<string, unknown>> {
  const msg = await piStream.result();
  return openAiCompletionsMessageFromAssistant(msg);
}
