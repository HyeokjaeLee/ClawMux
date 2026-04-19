import type { Message } from "./types.ts";

export interface EscalationRecord {
  tier: "MEDIUM" | "HEAVY";
  firstEscalatedAt: number;
  lastActivityAt: number;
}

export interface EscalationMemoryConfig {
  activeThresholdMs: number;
  maxLifetimeMs: number;
  fingerprintRootCount: number;
}

function djb2Hash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function extractText(
  content: string | ReadonlyArray<{ type: string; text?: string }> | null | undefined,
): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content.slice(0, 200);
  }
  let concatenated = "";
  for (const block of content) {
    if (block.type === "text" && block.text !== undefined) {
      concatenated += block.text;
    }
  }
  return concatenated.slice(0, 200);
}

function contentLength(
  content: string | ReadonlyArray<{ type: string; text?: string }> | null | undefined,
): number {
  if (content === null || content === undefined) {
    return 0;
  }
  if (typeof content === "string") {
    return content.length;
  }
  return extractText(content).length;
}

export class EscalationMemory {
  private readonly config: EscalationMemoryConfig;
  private readonly store: Map<string, EscalationRecord>;

  constructor(config: EscalationMemoryConfig) {
    this.config = config;
    this.store = new Map();
  }

  fingerprint(messages: ReadonlyArray<Message>): string {
    const count = this.config.fingerprintRootCount;
    const segments: string[] = [];
    for (let i = 0; i < count; i++) {
      const msg = messages[i];
      if (msg === undefined) {
        segments.push("::");
        continue;
      }
      const text = extractText(msg.content);
      const len = contentLength(msg.content);
      segments.push(`${msg.role}:${String(len)}:${djb2Hash(text)}`);
    }
    return segments.join("|");
  }

  lookup(messages: ReadonlyArray<Message>, nowMs?: number): EscalationRecord | null {
    this.evict(nowMs);
    return this.store.get(this.fingerprint(messages)) ?? null;
  }

  record(messages: ReadonlyArray<Message>, tier: "MEDIUM" | "HEAVY", nowMs?: number): void {
    const now = nowMs ?? Date.now();
    const fp = this.fingerprint(messages);
    const existing = this.store.get(fp);
    if (existing !== undefined && existing.tier === "HEAVY" && tier === "MEDIUM") {
      // No downgrade, but update activity time
      existing.lastActivityAt = now;
      return;
    }
    this.store.set(fp, {
      tier,
      firstEscalatedAt: existing?.firstEscalatedAt ?? now,
      lastActivityAt: now,
    });
  }

  touch(messages: ReadonlyArray<Message>, nowMs?: number): void {
    const now = nowMs ?? Date.now();
    const record = this.store.get(this.fingerprint(messages));
    if (record !== undefined) {
      record.lastActivityAt = now;
    }
  }

  evict(nowMs?: number): number {
    const now = nowMs ?? Date.now();
    let evicted = 0;
    for (const [fp, record] of this.store) {
      const inactive = now - record.lastActivityAt > this.config.activeThresholdMs;
      const expired = now - record.firstEscalatedAt > this.config.maxLifetimeMs;
      if (inactive || expired) {
        this.store.delete(fp);
        evicted++;
      }
    }
    return evicted;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
