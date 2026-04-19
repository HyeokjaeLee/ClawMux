export const ESCALATE_SIGNAL = "===CLAWMUX_ESCALATE===";

export type SignalDetectorResult =
  | { type: "passthrough"; text: string }
  | { type: "signal_detected" }
  | { type: "buffering" };

export class SignalDetector {
  private buffer = "";
  private detected = false;
  private pending: SignalDetectorResult[] = [];

  feed(char: string): SignalDetectorResult {
    if (this.pending.length > 0) {
      return this.pending.shift()!;
    }

    if (this.detected) {
      return { type: "signal_detected" };
    }

    if (this.buffer.length === 0) {
      if (char !== "=") {
        return { type: "passthrough", text: char };
      }
      this.buffer = char;
      return { type: "buffering" };
    }

    // Buffer non-empty: append and check
    const candidate = this.buffer + char;

    if (candidate === ESCALATE_SIGNAL) {
      this.detected = true;
      this.buffer = "";
      return { type: "signal_detected" };
    }

    if (ESCALATE_SIGNAL.startsWith(candidate)) {
      this.buffer = candidate;
      return { type: "buffering" };
    }

    // Diverged: flush buffer as passthrough, then re-feed the diverging char
    this.buffer = "";
    this.pending.push({ type: "passthrough", text: char });
    return { type: "passthrough", text: candidate.slice(0, -1) };
  }

  feedChunk(chunk: string): SignalDetectorResult[] {
    const out: SignalDetectorResult[] = [];
    for (let i = 0; i < chunk.length; i++) {
      out.push(this.feed(chunk[i]!));
      while (this.pending.length > 0) {
        out.push(this.pending.shift()!);
      }
    }
    return out;
  }

  flush(): string | null {
    if (this.buffer.length === 0) return null;
    const text = this.buffer;
    this.buffer = "";
    return text;
  }

  reset(): void {
    this.buffer = "";
    this.detected = false;
    this.pending.length = 0;
  }

  get isBuffering(): boolean {
    return this.buffer.length > 0;
  }
}
