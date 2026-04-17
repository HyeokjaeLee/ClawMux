interface ParsedOpenAIBody {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  stream: boolean;
  maxTokens?: number;
  rawBody: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMessageArray(
  value: unknown,
): value is Array<{ role: string; content: unknown }> {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      isRecord(item) && typeof item.role === "string" && "content" in item,
  );
}

function extractSystemMessage(
  messages: Array<{ role: string; content: unknown }>,
): {
  system: string | undefined;
  filtered: Array<{ role: string; content: unknown }>;
} {
  const systemMessages: string[] = [];
  const filtered: Array<{ role: string; content: unknown }> = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      if (typeof msg.content === "string") {
        systemMessages.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
            systemMessages.push(part.text);
          }
        }
      }
    } else {
      filtered.push(msg);
    }
  }

  return {
    system: systemMessages.length > 0 ? systemMessages.join("\n") : undefined,
    filtered,
  };
}

export function parseOpenAIBody(body: unknown): ParsedOpenAIBody {
  if (!isRecord(body)) {
    throw new Error("Request body must be a JSON object");
  }

  const model = typeof body.model === "string" ? body.model : "";
  if (!model) {
    throw new Error("Missing required field: model");
  }

  const rawMessages = body.messages ?? body.input;
  if (!isMessageArray(rawMessages)) {
    throw new Error(
      "Request must contain a valid 'messages' or 'input' array",
    );
  }

  const { system, filtered } = extractSystemMessage(rawMessages);

  const stream = body.stream === true;

  const rawMax = body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens;
  const maxTokens = typeof rawMax === "number" ? rawMax : undefined;

  const rawBody = { ...body } as Record<string, unknown>;

  return {
    model,
    messages: filtered,
    system,
    stream,
    maxTokens,
    rawBody,
  };
}
