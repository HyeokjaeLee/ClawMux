import { describe, it, expect } from "bun:test";
import { SignalDetector, ESCALATE_SIGNAL } from "./signal-detector.ts";

// ─── Helper ─────────────────────────────────────────────────────────

function results(feedChunk: string) {
  const d = new SignalDetector();
  return d.feedChunk(feedChunk);
}

function types(res: readonly { type: string }[]) {
  return res.map((r) => r.type);
}

function passthroughText(res: readonly { type: string; text?: string }[]) {
  return res
    .filter((r) => r.type === "passthrough")
    .map((r) => r.text ?? "");
}

// ─── 1. Plain text passthrough ──────────────────────────────────────

describe("plain text passthrough", () => {
  it('"hello" → 5 passthrough, each 1 char', () => {
    const r = results("hello");
    expect(r).toHaveLength(5);
    expect(types(r)).toEqual(["passthrough", "passthrough", "passthrough", "passthrough", "passthrough"]);
    expect(passthroughText(r)).toEqual(["h", "e", "l", "l", "o"]);
  });
});

// ─── 2. Triple equals buffered then flushed ─────────────────────────

describe('"===" buffering', () => {
  it("3 buffering, flush returns ===", () => {
    const d = new SignalDetector();
    const r = d.feedChunk("===");
    expect(r).toHaveLength(3);
    expect(types(r)).toEqual(["buffering", "buffering", "buffering"]);
    expect(d.isBuffering).toBe(true);
    const flushed = d.flush();
    expect(flushed).toBe("===");
    expect(d.isBuffering).toBe(false);
  });
});

// ─── 3. Full signal detection ───────────────────────────────────────

describe("full signal detection", () => {
  it('"===CLAWMUX_ESCALATE===" → 21 buffering + 1 signal_detected', () => {
    const d = new SignalDetector();
    const signal = ESCALATE_SIGNAL;
    expect(signal).toHaveLength(22);
    const r = d.feedChunk(signal);
    expect(r).toHaveLength(22);
    expect(r.slice(0, 21).every((x) => x.type === "buffering")).toBe(true);
    expect(r[21].type).toBe("signal_detected");
    expect(d.isBuffering).toBe(false);
  });
});

// ─── 4. Divergence on X ─────────────────────────────────────────────

describe('"===X" divergence', () => {
  it("3 buffering, then passthrough === and passthrough X", () => {
    const r = results("===X");
    // =→buf, =→buf, =→buf, X→diverge→pt "===", pt "X"
    expect(r).toHaveLength(5);
    expect(types(r.slice(0, 3))).toEqual(["buffering", "buffering", "buffering"]);
    expect(r[3].type).toBe("passthrough");
    if (r[3].type === "passthrough") {
      expect(r[3].text).toBe("===");
    }
    expect(r[4].type).toBe("passthrough");
    if (r[4].type === "passthrough") {
      expect(r[4].text).toBe("X");
    }
  });
});

// ─── 5. "a = 1" — space breaks prefix ───────────────────────────────

describe('"a = 1" passthrough', () => {
  it("all passthrough (space after = breaks prefix)", () => {
    const r = results("a = 1");
    // a→pt, space→pt, =→buf, space→diverge→pt "=", pt " ", 1→pt
    expect(types(r)).toEqual(["passthrough", "passthrough", "buffering", "passthrough", "passthrough", "passthrough"]);
    if (r[0].type === "passthrough") expect(r[0].text).toBe("a");
    if (r[1].type === "passthrough") expect(r[1].text).toBe(" ");
    if (r[3].type === "passthrough") expect(r[3].text).toBe("=");
    if (r[4].type === "passthrough") expect(r[4].text).toBe(" ");
    if (r[5].type === "passthrough") expect(r[5].text).toBe("1");
  });
});

// ─── 6. "x == y" — double equals then space ─────────────────────────

describe('"x == y" passthrough', () => {
  it("all passthrough (space after == breaks prefix)", () => {
    const r = results("x == y");
    // x→pt, space→pt, =→buf, =→buf, space→diverge→pt "==", pt " ", y→pt
    expect(types(r)).toEqual(["passthrough", "passthrough", "buffering", "buffering", "passthrough", "passthrough", "passthrough"]);
    if (r[4].type === "passthrough") expect(r[4].text).toBe("==");
    if (r[5].type === "passthrough") expect(r[5].text).toBe(" ");
    if (r[6].type === "passthrough") expect(r[6].text).toBe("y");
  });
});

// ─── 7. Partial signal flushed ──────────────────────────────────────

describe("partial signal flush", () => {
  it('"===CLAWMUX" flushed as text', () => {
    const d = new SignalDetector();
    const r = d.feedChunk("===CLAWMUX");
    expect(r).toHaveLength(10);
    expect(r.every((x) => x.type === "buffering")).toBe(true);
    const flushed = d.flush();
    expect(flushed).toBe("===CLAWMUX");
  });
});

// ─── 8. Post-signal suppression ──────────────────────────────────────

describe("post-signal suppression", () => {
  it("signal then more text → signal_detected for all subsequent chars", () => {
    const d = new SignalDetector();
    const signal = ESCALATE_SIGNAL;
    const r1 = d.feedChunk(signal);
    expect(r1.at(-1)!.type).toBe("signal_detected");

    const r2 = d.feedChunk("more text");
    expect(r2).toHaveLength(9);
    expect(r2.every((x) => x.type === "signal_detected")).toBe(true);
  });

  it("after reset, more text is passthrough again", () => {
    const d = new SignalDetector();
    d.feedChunk(ESCALATE_SIGNAL);
    d.reset();
    const r = d.feedChunk("hi");
    expect(r).toHaveLength(2);
    expect(types(r)).toEqual(["passthrough", "passthrough"]);
  });
});

// ─── 9. Korean text passthrough ─────────────────────────────────────

describe("Korean text passthrough", () => {
  it("all passthrough (no = chars)", () => {
    const text = "네 알겠습니다. ";
    const r = results(text);
    expect(r).toHaveLength(text.length);
    expect(r.every((x) => x.type === "passthrough")).toBe(true);
    expect(passthroughText(r).join("")).toBe(text);
  });
});

// ─── 10. Signal split across chunks ──────────────────────────────────

describe("signal split across feedChunk calls", () => {
  it("first chunk buffers, second chunk detects", () => {
    const d = new SignalDetector();
    const r1 = d.feedChunk("===CLAWMUX_ES");
    expect(r1.every((x) => x.type === "buffering")).toBe(true);

    const r2 = d.feedChunk("CALATE===");
    expect(r2.at(-1)!.type).toBe("signal_detected");
  });
});

// ─── 11. reset() mid-buffer ──────────────────────────────────────────

describe("reset mid-buffer", () => {
  it("clears buffer, next char starts fresh", () => {
    const d = new SignalDetector();
    d.feedChunk("===CLAW");
    expect(d.isBuffering).toBe(true);
    d.reset();
    expect(d.isBuffering).toBe(false);
    const r = d.feed("x");
    expect(r.type).toBe("passthrough");
    if (r.type === "passthrough") expect(r.text).toBe("x");
  });
});

// ─── 12. Empty feedChunk ─────────────────────────────────────────────

describe("empty feedChunk", () => {
  it("returns []", () => {
    const d = new SignalDetector();
    const r = d.feedChunk("");
    expect(r).toEqual([]);
  });
});

// ─── 13. Signal + trailing text (no reset) ───────────────────────────

describe("signal then trailing text without reset", () => {
  it("signal detected, then all subsequent chars suppressed", () => {
    const r = results("===CLAWMUX_ESCALATE===more text");
    const signalLen = ESCALATE_SIGNAL.length;
    expect(r).toHaveLength(signalLen + 9);
    expect(r.slice(0, 21).every((x) => x.type === "buffering")).toBe(true);
    expect(r.slice(21).every((x) => x.type === "signal_detected")).toBe(true);
  });
});

// ─── 14. "= = =" — spaces break prefix each time ────────────────────

describe('"= = =" pattern', () => {
  it("each space breaks the = prefix, passthrough emitted", () => {
    const r = results("= = =");
    // =→buf, space→diverge→pt "=", pt " ", =→buf, space→diverge→pt "=", pt " ", =→buf
    expect(types(r)).toEqual(["buffering", "passthrough", "passthrough", "buffering", "passthrough", "passthrough", "buffering"]);
    if (r[1].type === "passthrough") expect(r[1].text).toBe("=");
    if (r[2].type === "passthrough") expect(r[2].text).toBe(" ");
    if (r[4].type === "passthrough") expect(r[4].text).toBe("=");
    if (r[5].type === "passthrough") expect(r[5].text).toBe(" ");
    const d = new SignalDetector();
    d.feedChunk("= = =");
    expect(d.isBuffering).toBe(true);
    expect(d.flush()).toBe("=");
  });
});

// ─── 15. "===" + "\n" — reviewer note #4 ─────────────────────────────

describe('"===" + "\\n" — reviewer note #4', () => {
  it("3 buffering, then newline diverges: passthrough ===, passthrough \\n", () => {
    const d = new SignalDetector();
    const r1 = d.feedChunk("===");
    expect(r1).toHaveLength(3);
    expect(types(r1)).toEqual(["buffering", "buffering", "buffering"]);

    const r2 = d.feedChunk("\n");
    // Per reviewer note #4: two results — passthrough "===" then passthrough "\n"
    expect(r2).toHaveLength(2);
    expect(r2[0].type).toBe("passthrough");
    if (r2[0].type === "passthrough") expect(r2[0].text).toBe("===");
    expect(r2[1].type).toBe("passthrough");
    if (r2[1].type === "passthrough") expect(r2[1].text).toBe("\n");

    expect(d.isBuffering).toBe(false);
  });
});
