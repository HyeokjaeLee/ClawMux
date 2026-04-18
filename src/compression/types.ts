export type CompressionState = "idle" | "computing" | "ready" | "disabled";

export interface Session {
  id: string;
  messages: Array<{ role: string; content: unknown }>;
  tokenCount: number;
  compressionState: CompressionState;
  compressedSummary?: string;
  compressedMessages?: Array<{ role: string; content: unknown }>;
  snapshotIndex?: number;
  disabledReason?: string;
  lastAccess: number;
}
