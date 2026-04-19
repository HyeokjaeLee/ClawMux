import { describe, it, expect } from "bun:test";
import type { Message } from "./types.ts";
import { EscalationMemory } from "./escalation-memory.ts";

const defaultConfig = {
  activeThresholdMs: 300_000,
  maxLifetimeMs: 7_200_000,
  fingerprintRootCount: 5,
};

function makeMessages(count: number, role = "user", content = "hello"): Message[] {
  return Array.from({ length: count }, () => ({ role, content }));
}

describe("EscalationMemory", () => {
  describe("fingerprint", () => {
    it("1: same first 5 messages → same fingerprint", () => {
      const mem = new EscalationMemory(defaultConfig);
      const msgsA: Message[] = [
        { role: "user", content: "aaa" },
        { role: "assistant", content: "bbb" },
        { role: "user", content: "ccc" },
        { role: "assistant", content: "ddd" },
        { role: "user", content: "eee" },
        { role: "user", content: "extra" },
      ];
      const msgsB: Message[] = [
        { role: "user", content: "aaa" },
        { role: "assistant", content: "bbb" },
        { role: "user", content: "ccc" },
        { role: "assistant", content: "ddd" },
        { role: "user", content: "eee" },
      ];
      expect(mem.fingerprint(msgsA)).toBe(mem.fingerprint(msgsB));
    });

    it("2: arrays differing only after index 4 → same fingerprint", () => {
      const mem = new EscalationMemory(defaultConfig);
      const msgsA: Message[] = [
        { role: "user", content: "x" },
        { role: "assistant", content: "y" },
        { role: "user", content: "z" },
        { role: "assistant", content: "w" },
        { role: "user", content: "q" },
        { role: "user", content: "DIFFERENT_A" },
      ];
      const msgsB: Message[] = [
        { role: "user", content: "x" },
        { role: "assistant", content: "y" },
        { role: "user", content: "z" },
        { role: "assistant", content: "w" },
        { role: "user", content: "q" },
        { role: "user", content: "DIFFERENT_B" },
      ];
      expect(mem.fingerprint(msgsA)).toBe(mem.fingerprint(msgsB));
    });

    it("3: different first message → different fingerprint", () => {
      const mem = new EscalationMemory(defaultConfig);
      const msgsA: Message[] = [{ role: "user", content: "alpha" }];
      const msgsB: Message[] = [{ role: "user", content: "beta" }];
      expect(mem.fingerprint(msgsA)).not.toBe(mem.fingerprint(msgsB));
    });

    it("4: empty array → consistent fingerprint (all segments empty)", () => {
      const mem = new EscalationMemory(defaultConfig);
      const fp1 = mem.fingerprint([]);
      const fp2 = mem.fingerprint([]);
      expect(fp1).toBe(fp2);
      expect(typeof fp1).toBe("string");
    });

    it("15: array content blocks with text — fingerprint extracts text correctly", () => {
      const mem = new EscalationMemory(defaultConfig);
      const stringMsg: Message = { role: "user", content: "hello world" };
      const blockMsg: Message = {
        role: "user",
        content: [{ type: "text", text: "hello world" }],
      };
      expect(mem.fingerprint([stringMsg])).toBe(mem.fingerprint([blockMsg]));
    });
  });

  describe("lookup / record", () => {
    it("5: record() then lookup() returns the record", () => {
      const mem = new EscalationMemory(defaultConfig);
      const msgs = makeMessages(1);
      mem.record(msgs, "MEDIUM", 1000);
      const result = mem.lookup(msgs, 1000);
      expect(result).not.toBeNull();
      expect(result!.tier).toBe("MEDIUM");
      expect(result!.firstEscalatedAt).toBe(1000);
      expect(result!.lastActivityAt).toBe(1000);
    });

    it("6: record() with higher tier upgrades MEDIUM → HEAVY", () => {
      const mem = new EscalationMemory(defaultConfig);
      const msgs = makeMessages(1);
      mem.record(msgs, "MEDIUM", 1000);
      mem.record(msgs, "HEAVY", 2000);
      const result = mem.lookup(msgs, 2000);
      expect(result!.tier).toBe("HEAVY");
      expect(result!.firstEscalatedAt).toBe(1000);
      expect(result!.lastActivityAt).toBe(2000);
    });

    it("7: record() with lower tier after HEAVY → stays HEAVY, lastActivityAt updated", () => {
      const mem = new EscalationMemory(defaultConfig);
      const msgs = makeMessages(1);
      mem.record(msgs, "HEAVY", 1000);
      mem.record(msgs, "MEDIUM", 5000);
      const result = mem.lookup(msgs, 5000);
      expect(result!.tier).toBe("HEAVY");
      expect(result!.firstEscalatedAt).toBe(1000);
      expect(result!.lastActivityAt).toBe(5000);
    });
  });

  describe("evict", () => {
    it("8: evict by activeThreshold: record at t=0, evict(activeThresholdMs+1) removes 1", () => {
      const mem = new EscalationMemory({ ...defaultConfig, activeThresholdMs: 1000 });
      const msgs = makeMessages(1);
      mem.record(msgs, "MEDIUM", 0);
      const evicted = mem.evict(1001);
      expect(evicted).toBe(1);
      expect(mem.size).toBe(0);
    });

    it("9: evict by maxLifetime: record at t=0, touch at t=100, touch at t=200, evict(maxLifetimeMs+1) removes 1", () => {
      const mem = new EscalationMemory({ ...defaultConfig, activeThresholdMs: 10_000, maxLifetimeMs: 5000 });
      const msgs = makeMessages(1);
      mem.record(msgs, "MEDIUM", 0);
      mem.touch(msgs, 100);
      mem.touch(msgs, 200);
      const evicted = mem.evict(5001);
      expect(evicted).toBe(1);
      expect(mem.size).toBe(0);
    });

    it("10: evict within both thresholds → no removal", () => {
      const mem = new EscalationMemory({ ...defaultConfig, activeThresholdMs: 10_000, maxLifetimeMs: 100_000 });
      const msgs = makeMessages(1);
      mem.record(msgs, "MEDIUM", 0);
      const evicted = mem.evict(5000);
      expect(evicted).toBe(0);
      expect(mem.size).toBe(1);
    });

    it("14: evict() returns count", () => {
      const mem = new EscalationMemory({ ...defaultConfig, activeThresholdMs: 100 });
      const msgs1: Message[] = [{ role: "user", content: "a" }];
      const msgs2: Message[] = [{ role: "user", content: "b" }];
      const msgs3: Message[] = [{ role: "user", content: "c" }];
      mem.record(msgs1, "MEDIUM", 0);
      mem.record(msgs2, "HEAVY", 0);
      mem.record(msgs3, "MEDIUM", 0);
      const evicted = mem.evict(200);
      expect(evicted).toBe(3);
    });

    it("16: lookup(msgs, futureTime) → returns null after eviction", () => {
      const mem = new EscalationMemory({ ...defaultConfig, activeThresholdMs: 500 });
      const msgs = makeMessages(1);
      mem.record(msgs, "MEDIUM", 0);
      const result = mem.lookup(msgs, 1000);
      expect(result).toBeNull();
    });
  });

  describe("touch", () => {
    it("11: touch() updates lastActivityAt", () => {
      const mem = new EscalationMemory(defaultConfig);
      const msgs = makeMessages(1);
      mem.record(msgs, "MEDIUM", 1000);
      mem.touch(msgs, 5000);
      const result = mem.lookup(msgs, 5000);
      expect(result!.lastActivityAt).toBe(5000);
    });

    it("12: touch() on unknown fingerprint → no-op, size unchanged", () => {
      const mem = new EscalationMemory(defaultConfig);
      const msgs = makeMessages(1);
      expect(mem.size).toBe(0);
      mem.touch(msgs, 5000);
      expect(mem.size).toBe(0);
    });
  });

  describe("clear", () => {
    it("13: clear() → size becomes 0", () => {
      const mem = new EscalationMemory(defaultConfig);
      const msgs = makeMessages(1);
      mem.record(msgs, "HEAVY", 0);
      expect(mem.size).toBe(1);
      mem.clear();
      expect(mem.size).toBe(0);
    });
  });
});
