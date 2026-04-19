import { describe, it, expect } from "bun:test";
import {
  injectEscalationInstruction,
  ESCALATION_INSTRUCTION,
  INJECT_FOR_TIERS,
} from "./instruction-injector.ts";
import { ESCALATE_SIGNAL } from "./signal-detector.ts";
import type { Message } from "./types.ts";

describe("injectEscalationInstruction", () => {
  it("appends to string system message, leaves user unchanged", () => {
    const input: Message[] = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "hi" },
    ];
    const result = injectEscalationInstruction(input);

    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("system");
    expect(result[0]!.content).toBe(
      "You are helpful\n\n" + ESCALATION_INSTRUCTION,
    );
    expect(result[1]).toEqual({ role: "user", content: "hi" });
  });

  it("prepends system message when first message is user", () => {
    const input: Message[] = [{ role: "user", content: "hi" }];
    const result = injectEscalationInstruction(input);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: "system", content: ESCALATION_INSTRUCTION });
    expect(result[1]).toEqual({ role: "user", content: "hi" });
  });

  it("appends text block to array system content", () => {
    const input: Message[] = [
      { role: "system", content: [{ type: "text", text: "You are helpful" }] },
    ];
    const result = injectEscalationInstruction(input);

    expect(result).toHaveLength(1);
    const content = result[0]!.content as ReadonlyArray<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "You are helpful" });
    expect(content[1]).toEqual({ type: "text", text: ESCALATION_INSTRUCTION });
  });

  it("appends text block alongside non-text content block", () => {
    const input: Message[] = [
      { role: "system", content: [{ type: "image" }] },
    ];
    const result = injectEscalationInstruction(input);

    expect(result).toHaveLength(1);
    const content = result[0]!.content as ReadonlyArray<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "image" });
    expect(content[1]).toEqual({ type: "text", text: ESCALATION_INSTRUCTION });
  });

  it("returns system message for empty input", () => {
    const result = injectEscalationInstruction([]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "system", content: ESCALATION_INSTRUCTION });
  });

  it("does not mutate input array or nested objects", () => {
    const originalFirst: Message = {
      role: "system",
      content: "original",
    };
    const input: Message[] = [originalFirst, { role: "user", content: "hi" }];
    const originalSnapshot = JSON.stringify(input);

    const result = injectEscalationInstruction(input);

    expect(result).not.toBe(input);
    expect(result[0]).not.toBe(input[0]);
    expect(result[1]).not.toBe(input[1]);
    expect(JSON.stringify(input)).toBe(originalSnapshot);
  });

  it("output content contains exact ESCALATE_SIGNAL substring", () => {
    const result = injectEscalationInstruction([]);
    const content = result[0]!.content as string;
    expect(content).toContain(ESCALATE_SIGNAL);
  });

  it("only modifies first system message when multiple system messages exist", () => {
    const input: Message[] = [
      { role: "system", content: "s1" },
      { role: "system", content: "s2" },
      { role: "user", content: "u" },
    ];
    const result = injectEscalationInstruction(input);

    expect(result).toHaveLength(3);
    expect(result[0]!.content).toBe("s1\n\n" + ESCALATION_INSTRUCTION);
    expect(result[1]).toEqual({ role: "system", content: "s2" });
    expect(result[2]).toEqual({ role: "user", content: "u" });
  });
});

describe("INJECT_FOR_TIERS", () => {
  it("contains only LIGHT", () => {
    expect(INJECT_FOR_TIERS.has("LIGHT")).toBe(true);
    expect(INJECT_FOR_TIERS.has("MEDIUM")).toBe(false);
    expect(INJECT_FOR_TIERS.has("HEAVY")).toBe(false);
    expect(INJECT_FOR_TIERS.size).toBe(1);
  });
});

describe("ESCALATION_INSTRUCTION", () => {
  it("contains the ESCALATE_SIGNAL substring", () => {
    expect(ESCALATION_INSTRUCTION).toContain(ESCALATE_SIGNAL);
  });
});
