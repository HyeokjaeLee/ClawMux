export type CompressionState = "idle" | "computing" | "ready";

export interface Session {
  id: string;
  messages: Array<{ role: string; content: unknown }>;
  tokenCount: number;
  compressionState: CompressionState;
  compressedSummary?: string;
  compressedMessages?: Array<{ role: string; content: unknown }>;
  lastAccess: number;
}
