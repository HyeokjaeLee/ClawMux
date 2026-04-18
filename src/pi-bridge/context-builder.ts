import type {
  Context,
  Message,
  TextContent,
  ImageContent,
  ToolCall,
  Tool,
} from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ParsedRequest } from "../adapters/types.ts";

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as { type?: string; text?: string };
          if (p.type === "text" && typeof p.text === "string") return p.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function parseImagePart(part: Record<string, unknown>): ImageContent | undefined {
  const type = String(part.type ?? "");
  if (type === "image") {
    const source = part.source as Record<string, unknown> | undefined;
    if (source && source.type === "base64") {
      return {
        type: "image",
        data: String(source.data ?? ""),
        mimeType: String(source.media_type ?? "image/png"),
      };
    }
  }
  if (type === "image_url") {
    const imageUrl = part.image_url as Record<string, unknown> | undefined;
    const url = typeof imageUrl?.url === "string" ? imageUrl.url : "";
    const match = url.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return { type: "image", data: match[2], mimeType: match[1] };
    }
  }
  return undefined;
}

function buildUserContent(content: unknown): string | Array<TextContent | ImageContent> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  const parts: Array<TextContent | ImageContent> = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push({ type: "text", text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const t = String(p.type ?? "");
    if (t === "text") {
      parts.push({ type: "text", text: String(p.text ?? "") });
    } else if (t === "image" || t === "image_url") {
      const img = parseImagePart(p);
      if (img) parts.push(img);
    }
  }
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

function buildAssistantContent(
  content: unknown,
): Array<TextContent | ToolCall> {
  const blocks: Array<TextContent | ToolCall> = [];
  if (typeof content === "string") {
    if (content) blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const t = String(p.type ?? "");
    if (t === "text") {
      blocks.push({ type: "text", text: String(p.text ?? "") });
    } else if (t === "tool_use") {
      blocks.push({
        type: "toolCall",
        id: String(p.id ?? ""),
        name: String(p.name ?? ""),
        arguments:
          p.input && typeof p.input === "object"
            ? (p.input as Record<string, unknown>)
            : {},
      });
    }
  }
  return blocks;
}

interface ToolResultBlock {
  toolUseId: string;
  content: Array<TextContent | ImageContent>;
  isError: boolean;
}

function extractToolResults(content: unknown): ToolResultBlock[] {
  const results: ToolResultBlock[] = [];
  if (!Array.isArray(content)) return results;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (p.type !== "tool_result") continue;
    const rawContent = p.content;
    const parts: Array<TextContent | ImageContent> = [];
    if (typeof rawContent === "string") {
      parts.push({ type: "text", text: rawContent });
    } else if (Array.isArray(rawContent)) {
      for (const c of rawContent) {
        if (!c || typeof c !== "object") continue;
        const cp = c as Record<string, unknown>;
        if (cp.type === "text") {
          parts.push({ type: "text", text: String(cp.text ?? "") });
        } else if (cp.type === "image") {
          const img = parseImagePart(cp);
          if (img) parts.push(img);
        }
      }
    }
    results.push({
      toolUseId: String(p.tool_use_id ?? ""),
      content: parts,
      isError: p.is_error === true,
    });
  }
  return results;
}

function buildTools(rawBody: Record<string, unknown>): Tool[] | undefined {
  const toolsRaw = rawBody.tools;
  if (!Array.isArray(toolsRaw) || toolsRaw.length === 0) return undefined;
  const tools: Tool[] = [];
  for (const item of toolsRaw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const func = p.function as Record<string, unknown> | undefined;
    const name =
      typeof p.name === "string"
        ? p.name
        : typeof func?.name === "string"
          ? String(func.name)
          : "";
    if (!name) continue;
    const description =
      typeof p.description === "string"
        ? p.description
        : typeof func?.description === "string"
          ? String(func.description)
          : "";
    const parameters =
      (p.input_schema as Record<string, unknown> | undefined) ??
      (p.parameters as Record<string, unknown> | undefined) ??
      (func?.parameters as Record<string, unknown> | undefined) ??
      (func?.input_schema as Record<string, unknown> | undefined) ??
      {};
    tools.push({
      name,
      description,
      parameters: Type.Unsafe(parameters),
    });
  }
  return tools.length > 0 ? tools : undefined;
}

export function buildPiContext(parsed: ParsedRequest): Context {
  let systemPrompt: string | undefined;
  if (typeof parsed.system === "string") {
    systemPrompt = parsed.system;
  } else if (Array.isArray(parsed.system)) {
    systemPrompt = parsed.system
      .filter((s) => s && typeof s === "object" && s.type === "text")
      .map((s) => s.text)
      .join("\n");
  }

  const messages: Message[] = [];
  for (const msg of parsed.messages) {
    const now = Date.now();

    if (msg.role === "system") {
      if (!systemPrompt) systemPrompt = extractTextFromContent(msg.content);
      continue;
    }

    if (msg.role === "user") {
      const toolResults = extractToolResults(msg.content);
      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          messages.push({
            role: "toolResult",
            toolCallId: tr.toolUseId,
            toolName: "",
            content: tr.content,
            isError: tr.isError,
            timestamp: now,
          });
        }
        const textOnly = Array.isArray(msg.content)
          ? msg.content.filter(
              (c) =>
                c &&
                typeof c === "object" &&
                (c as { type?: string }).type !== "tool_result",
            )
          : [];
        if (textOnly.length > 0) {
          messages.push({
            role: "user",
            content: buildUserContent(textOnly),
            timestamp: now,
          });
        }
        continue;
      }
      messages.push({
        role: "user",
        content: buildUserContent(msg.content),
        timestamp: now,
      });
      continue;
    }

    if (msg.role === "assistant") {
      const blocks = buildAssistantContent(msg.content);
      messages.push({
        role: "assistant",
        content: blocks,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: now,
      });
    }
  }

  const tools = buildTools(parsed.rawBody);
  return { systemPrompt, messages, tools };
}

export { extractTextFromContent };
