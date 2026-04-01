export interface ParsedRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string | Array<{ type: string; text: string }>;
  stream: boolean;
  maxTokens?: number;
  rawBody: Record<string, unknown>;
}

export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface AuthInfo {
  apiKey: string;
  headerName: string;
  headerValue: string;
}

export interface ApiAdapter {
  readonly apiType: string;
  parseRequest(body: unknown): ParsedRequest;
  buildUpstreamRequest(
    parsed: ParsedRequest,
    targetModel: string,
    baseUrl: string,
    auth: AuthInfo,
  ): UpstreamRequest;
  modifyMessages(
    rawBody: Record<string, unknown>,
    compressedMessages: Array<{ role: string; content: unknown }>,
  ): Record<string, unknown>;
}
