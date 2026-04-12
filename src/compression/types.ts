export type CompressionState = "idle" | "computing" | "ready";

export interface Session {
  id: string;
  messages: Array<{ role: string; content: unknown }>;
  tokenCount: number;
  compressionState: CompressionState;
  compressedSummary?: string;
  compressedMessages?: Array<{ role: string; content: unknown }>;
  /** Index into messages at the time compression was triggered. Messages after this index were not included in the summary. */
  snapshotIndex?: number;
  lastAccess: number;
}
