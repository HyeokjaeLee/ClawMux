/** Universal parsed response (non-streaming) */
export interface ParsedResponse {
  id: string;
  model: string;
  content: string;
  role: "assistant";
  stopReason: string | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/** Universal stream event discriminated union (streaming) */
export type StreamEvent =
  | { type: "message_start"; id: string; model: string }
  | { type: "content_delta"; text: string; index: number }
  | { type: "content_stop"; index: number }
  | {
      type: "message_stop";
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: "error"; message: string };
