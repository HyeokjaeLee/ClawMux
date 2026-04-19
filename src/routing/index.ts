export { SignalDetector, ESCALATE_SIGNAL } from "./signal-detector.ts";
export type { SignalDetectorResult } from "./signal-detector.ts";

export { EscalationMemory } from "./escalation-memory.ts";
export type { EscalationMemoryConfig } from "./escalation-memory.ts";

export { injectEscalationInstruction, INJECT_FOR_TIERS, ESCALATION_INSTRUCTION } from "./instruction-injector.ts";

export { SignalRouter, NEXT_TIER } from "./signal-router.ts";
export type { SignalRouterConfig } from "./signal-router.ts";

export type { Tier, Message, ContentBlock, RoutingDecision } from "./types.ts";
