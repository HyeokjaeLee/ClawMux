import type {
  ApiAdapter,
  AuthInfo,
  ParsedRequest,
  UpstreamRequest,
} from "./types.ts";
import { registerAdapter } from "./registry.ts";

interface GooglePart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GoogleContent {
  role?: string;
  parts: GooglePart[];
}

interface GoogleRequestBody {
  model?: string;
  contents?: GoogleContent[];
  systemInstruction?: { parts: GooglePart[] };
  generationConfig?: {
    maxOutputTokens?: number;
    [key: string]: unknown;
  };
  stream?: boolean;
  [key: string]: unknown;
}

function googleRoleToStandard(role: string | undefined): string {
  if (role === "model") return "assistant";
  return role ?? "user";
}

function standardRoleToGoogle(role: string): string {
  if (role === "assistant") return "model";
  return "user";
}

function contentsToMessages(
  contents: GoogleContent[],
): Array<{ role: string; content: unknown }> {
  return contents.map((c) => {
    const text = c.parts
      .filter((p) => p.text !== undefined)
      .map((p) => p.text)
      .join("");
    return {
      role: googleRoleToStandard(c.role),
      content: text || c.parts,
    };
  });
}

function messagesToContents(
  messages: Array<{ role: string; content: unknown }>,
): GoogleContent[] {
  return messages.map((m) => ({
    role: standardRoleToGoogle(m.role),
    parts:
      typeof m.content === "string"
        ? [{ text: m.content }]
        : Array.isArray(m.content)
          ? (m.content as GooglePart[])
          : [{ text: String(m.content) }],
  }));
}

export class GoogleGenerativeAIAdapter implements ApiAdapter {
  readonly apiType = "google-generative-ai" as const;

  parseRequest(body: unknown): ParsedRequest {
    const raw = body as GoogleRequestBody;
    const model = raw.model ?? "";
    const contents = raw.contents ?? [];
    const messages = contentsToMessages(contents);

    let system: string | undefined;
    if (raw.systemInstruction?.parts) {
      system = raw.systemInstruction.parts
        .filter((p) => p.text !== undefined)
        .map((p) => p.text)
        .join("");
    }

    return {
      model,
      messages,
      system,
      stream: raw.stream !== false,
      maxTokens: raw.generationConfig?.maxOutputTokens,
      rawBody: raw as Record<string, unknown>,
    };
  }

  buildUpstreamRequest(
    parsed: ParsedRequest,
    targetModel: string,
    baseUrl: string,
    auth: AuthInfo,
  ): UpstreamRequest {
    const endpoint = parsed.stream
      ? `${baseUrl}/v1beta/models/${targetModel}:streamGenerateContent?alt=sse`
      : `${baseUrl}/v1beta/models/${targetModel}:generateContent`;

    const contents = messagesToContents(parsed.messages);

    const requestBody: Record<string, unknown> = {
      ...parsed.rawBody,
      contents,
    };

    delete requestBody.model;
    delete requestBody.stream;

    if (parsed.system) {
      requestBody.systemInstruction = {
        parts: [{ text: parsed.system }],
      };
    }

    if (parsed.maxTokens !== undefined) {
      requestBody.generationConfig = {
        ...(requestBody.generationConfig as Record<string, unknown> | undefined),
        maxOutputTokens: parsed.maxTokens,
      };
    }

    return {
      url: endpoint,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [auth.headerName || "x-goog-api-key"]: auth.headerValue || auth.apiKey,
      },
      body: JSON.stringify(requestBody),
    };
  }

  modifyMessages(
    rawBody: Record<string, unknown>,
    compressedMessages: Array<{ role: string; content: unknown }>,
  ): Record<string, unknown> {
    return {
      ...rawBody,
      contents: messagesToContents(compressedMessages),
    };
  }
}

const googleAdapter = new GoogleGenerativeAIAdapter();
registerAdapter(googleAdapter);

export default googleAdapter;
