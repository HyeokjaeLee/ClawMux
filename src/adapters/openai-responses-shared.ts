const CONTENT_TYPE_MAP: Record<string, string> = {
  text: "input_text",
  image_url: "input_image",
};

const KEYS_UNSUPPORTED_BY_RESPONSES_INPUT = new Set([
  "tool_calls",
  "tool_call_id",
  "name",
  "function_call",
  "reasoning_content",
  "reasoning",
  "thinking",
]);

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (KEYS_UNSUPPORTED_BY_RESPONSES_INPUT.has(k)) continue;
      out[k] = sanitizeValue(v);
    }
    return out;
  }
  return value;
}

function convertContentPart(part: Record<string, unknown>): Record<string, unknown> {
  const partType = String(part.type ?? "");
  const mapped = CONTENT_TYPE_MAP[partType];
  const sanitized = sanitizeValue(part) as Record<string, unknown>;
  if (mapped) {
    return { ...sanitized, type: mapped };
  }
  return sanitized;
}

export function toResponsesInput(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return messages
    .filter((msg) => msg.role !== "tool")
    .map((msg) => {
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(msg)) {
        if (KEYS_UNSUPPORTED_BY_RESPONSES_INPUT.has(key)) continue;
        cleaned[key] = sanitizeValue(value);
      }

      const content = cleaned.content;
      if (Array.isArray(content)) {
        cleaned.content = content.map((part: unknown) => {
          if (typeof part === "object" && part !== null) {
            return convertContentPart(part as Record<string, unknown>);
          }
          return part;
        });
      }

      return cleaned;
    })
    .filter((msg) => msg.content != null);
}
