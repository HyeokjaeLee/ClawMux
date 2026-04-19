import type { Tier, Message } from "./types.ts";
import { ESCALATE_SIGNAL } from "./signal-detector.ts";

export const INJECT_FOR_TIERS: ReadonlySet<Tier> = new Set<Tier>(["LIGHT"]);

export const ESCALATION_INSTRUCTION: string =
  `If you cannot handle this request fully (due to complexity, missing context, or capability limits), output EXACTLY the following marker with no other text on that line: ${ESCALATE_SIGNAL}\nDo not explain. Do not ask permission. Just emit the marker and stop.`;

export function injectEscalationInstruction(
  messages: ReadonlyArray<Message>,
): ReadonlyArray<Message> {
  if (messages.length === 0) {
    return [{ role: "system", content: ESCALATION_INSTRUCTION }];
  }

  const first = messages[0]!;

  const rest = messages.slice(1).map((m) => ({ ...m }));

  if (first.role !== "system") {
    return [
      { role: "system", content: ESCALATION_INSTRUCTION },
      { ...first },
      ...rest,
    ];
  }

  if (typeof first.content === "string") {
    return [
      { role: "system", content: first.content + "\n\n" + ESCALATION_INSTRUCTION },
      ...rest,
    ];
  }

  return [
    {
      role: "system",
      content: [...first.content, { type: "text", text: ESCALATION_INSTRUCTION }],
    },
    ...rest,
  ];
}
