import type { Tier, Message } from "./types.ts";
import { SignalDetector } from "./signal-detector.ts";
import {
  EscalationMemory,
  type EscalationMemoryConfig,
} from "./escalation-memory.ts";
import {
  injectEscalationInstruction,
  INJECT_FOR_TIERS,
} from "./instruction-injector.ts";

export const NEXT_TIER: Record<Tier, Tier | null> = {
  LIGHT: "MEDIUM",
  MEDIUM: "HEAVY",
  HEAVY: null,
};

export interface SignalRouterConfig {
  escalation: EscalationMemoryConfig;
  enabled: boolean;
}

export class SignalRouter {
  private readonly _memory: EscalationMemory;
  private readonly _enabled: boolean;

  constructor(config: SignalRouterConfig) {
    this._memory = new EscalationMemory(config.escalation);
    this._enabled = config.enabled;
  }

  selectInitialTier(
    messages: ReadonlyArray<Message>,
    nowMs?: number,
  ): Tier {
    if (!this._enabled) return "MEDIUM";

    const record = this._memory.lookup(messages, nowMs);
    if (record !== null) return record.tier;

    return "LIGHT";
  }

  shouldInjectInstruction(tier: Tier): boolean {
    return this._enabled && INJECT_FOR_TIERS.has(tier);
  }

  injectInstructionIfNeeded(
    tier: Tier,
    messages: ReadonlyArray<Message>,
  ): ReadonlyArray<Message> {
    if (this.shouldInjectInstruction(tier)) {
      return injectEscalationInstruction(messages);
    }
    return messages;
  }

  createSignalDetector(): SignalDetector {
    return new SignalDetector();
  }

  handleEscalation(
    _messages: ReadonlyArray<Message>,
    fromTier: Tier,
  ): Tier | null {
    return NEXT_TIER[fromTier];
  }

  recordSuccessfulEscalation(
    messages: ReadonlyArray<Message>,
    tier: "MEDIUM" | "HEAVY",
    nowMs?: number,
  ): void {
    this._memory.record(messages, tier, nowMs);
  }

  touchActivity(
    messages: ReadonlyArray<Message>,
    nowMs?: number,
  ): void {
    this._memory.touch(messages, nowMs);
  }

  get memory(): EscalationMemory {
    return this._memory;
  }

  get enabled(): boolean {
    return this._enabled;
  }
}
