import { describe, it, expect } from "bun:test";
import type { Message } from "./types.ts";
import { SignalRouter, NEXT_TIER } from "./signal-router.ts";

const makeRouter = (enabled = true) =>
  new SignalRouter({
    enabled,
    escalation: {
      activeThresholdMs: 300_000,
      maxLifetimeMs: 7_200_000,
      fingerprintRootCount: 5,
    },
  });

const msgs: ReadonlyArray<Message> = [
  { role: "user", content: "Hello world" },
  { role: "assistant", content: "Hi there" },
];

describe("SignalRouter", () => {
  const NOW = 1_000_000;

  it("no memory → selectInitialTier returns LIGHT", () => {
    const router = makeRouter();
    expect(router.selectInitialTier(msgs, NOW)).toBe("LIGHT");
  });

  it("record MEDIUM within threshold → selectInitialTier returns MEDIUM", () => {
    const router = makeRouter();
    router.recordSuccessfulEscalation(msgs, "MEDIUM", NOW);
    expect(router.selectInitialTier(msgs, NOW + 100)).toBe("MEDIUM");
  });

  it("record HEAVY within threshold → selectInitialTier returns HEAVY", () => {
    const router = makeRouter();
    router.recordSuccessfulEscalation(msgs, "HEAVY", NOW);
    expect(router.selectInitialTier(msgs, NOW + 100)).toBe("HEAVY");
  });

  it("record expired (activeThreshold exceeded) → returns LIGHT, record evicted", () => {
    const router = makeRouter();
    router.recordSuccessfulEscalation(msgs, "MEDIUM", NOW);
    // activeThresholdMs = 300_000
    const result = router.selectInitialTier(msgs, NOW + 300_001);
    expect(result).toBe("LIGHT");
  });

  it("record expired (maxLifetime exceeded) → returns LIGHT", () => {
    const router = makeRouter();
    router.recordSuccessfulEscalation(msgs, "HEAVY", NOW);
    // maxLifetimeMs = 7_200_000
    const result = router.selectInitialTier(msgs, NOW + 7_200_001);
    expect(result).toBe("LIGHT");
  });

  it("shouldInjectInstruction(LIGHT) with enabled=true → true", () => {
    const router = makeRouter(true);
    expect(router.shouldInjectInstruction("LIGHT")).toBe(true);
  });

  it("shouldInjectInstruction(MEDIUM) → true", () => {
    const router = makeRouter(true);
    expect(router.shouldInjectInstruction("MEDIUM")).toBe(true);
  });

  it("shouldInjectInstruction(HEAVY) → false", () => {
    const router = makeRouter(true);
    expect(router.shouldInjectInstruction("HEAVY")).toBe(false);
  });

  it("handleEscalation(msgs, LIGHT) → MEDIUM", () => {
    const router = makeRouter();
    expect(router.handleEscalation(msgs, "LIGHT")).toBe("MEDIUM");
  });

  it("handleEscalation(msgs, MEDIUM) → HEAVY", () => {
    const router = makeRouter();
    expect(router.handleEscalation(msgs, "MEDIUM")).toBe("HEAVY");
  });

  it("handleEscalation(msgs, HEAVY) → null", () => {
    const router = makeRouter();
    expect(router.handleEscalation(msgs, "HEAVY")).toBeNull();
  });

  it("enabled=false → selectInitialTier always MEDIUM", () => {
    const router = makeRouter(false);
    expect(router.selectInitialTier(msgs, NOW)).toBe("MEDIUM");
    // Even after recording, still MEDIUM since enabled=false skips memory lookup
    router.recordSuccessfulEscalation(msgs, "HEAVY", NOW);
    expect(router.selectInitialTier(msgs, NOW + 100)).toBe("MEDIUM");
  });

  it("enabled=false → shouldInjectInstruction always false", () => {
    const router = makeRouter(false);
    expect(router.shouldInjectInstruction("LIGHT")).toBe(false);
    expect(router.shouldInjectInstruction("MEDIUM")).toBe(false);
    expect(router.shouldInjectInstruction("HEAVY")).toBe(false);
  });

  it("recordSuccessfulEscalation then selectInitialTier → returns escalated tier", () => {
    const router = makeRouter();
    router.recordSuccessfulEscalation(msgs, "MEDIUM", NOW);
    expect(router.selectInitialTier(msgs, NOW + 50)).toBe("MEDIUM");

    // Escalate to HEAVY
    router.recordSuccessfulEscalation(msgs, "HEAVY", NOW + 200);
    expect(router.selectInitialTier(msgs, NOW + 250)).toBe("HEAVY");
  });

  it("touchActivity refreshes record (lookup within threshold after touch)", () => {
    const router = makeRouter();
    router.recordSuccessfulEscalation(msgs, "MEDIUM", NOW);

    // Touch refreshes lastActivityAt to NOW + 100_000
    router.touchActivity(msgs, NOW + 100_000);

    // NOW + 399_999 - (NOW + 100_000) = 299_999 < activeThresholdMs (300_000) → still active
    expect(router.selectInitialTier(msgs, NOW + 399_999)).toBe("MEDIUM");

    // NOW + 400_001 - (NOW + 100_000) = 300_001 > activeThresholdMs → expired, returns LIGHT
    expect(router.selectInitialTier(msgs, NOW + 400_001)).toBe("LIGHT");
  });

  it("createSignalDetector returns fresh instance (reference inequality)", () => {
    const router = makeRouter();
    const a = router.createSignalDetector();
    const b = router.createSignalDetector();
    expect(a).not.toBe(b);
  });

  it("injectInstructionIfNeeded injects for LIGHT and MEDIUM; HEAVY returns same reference", () => {
    const router = makeRouter();
    const lightResult = router.injectInstructionIfNeeded("LIGHT", msgs);
    expect(lightResult.length).toBeGreaterThan(msgs.length);
    expect(lightResult[0]!.role).toBe("system");

    const mediumResult = router.injectInstructionIfNeeded("MEDIUM", msgs);
    expect(mediumResult.length).toBeGreaterThan(msgs.length);
    expect(mediumResult[0]!.role).toBe("system");

    const heavyResult = router.injectInstructionIfNeeded("HEAVY", msgs);
    expect(heavyResult).toBe(msgs);
  });

  it("injectInstructionIfNeeded with enabled=false returns same reference even for LIGHT", () => {
    const router = makeRouter(false);
    const result = router.injectInstructionIfNeeded("LIGHT", msgs);
    expect(result).toBe(msgs);
  });
});

describe("NEXT_TIER", () => {
  it("maps LIGHT → MEDIUM → HEAVY → null", () => {
    expect(NEXT_TIER.LIGHT).toBe("MEDIUM");
    expect(NEXT_TIER.MEDIUM).toBe("HEAVY");
    expect(NEXT_TIER.HEAVY).toBeNull();
  });
});
