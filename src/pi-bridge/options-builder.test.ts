import { describe, test, expect, beforeEach } from "bun:test";
import { buildPiOptions } from "./options-builder.ts";
import type { ParsedRequest, AuthInfo } from "../adapters/types.ts";

function makeParsed(
  overrides: Partial<ParsedRequest> = {},
): ParsedRequest {
  return {
    model: "m",
    messages: [],
    rawBody: {},
    stream: false,
    ...overrides,
  };
}

function makeAuth(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return { apiKey: "k", headerName: "", headerValue: "", ...overrides };
}

describe("buildPiOptions", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_OAUTH_TOKEN;
  });

  test("passes apiKey through for non-OAuth providers", () => {
    const opts = buildPiOptions(makeParsed(), makeAuth({ apiKey: "abc" }), "anthropic");
    expect(opts.apiKey).toBe("abc");
  });

  test("propagates temperature from rawBody", () => {
    const opts = buildPiOptions(
      makeParsed({ rawBody: { temperature: 0.7 } }),
      makeAuth(),
      "anthropic",
    );
    expect(opts.temperature).toBe(0.7);
  });

  test("propagates maxTokens from parsed field", () => {
    const opts = buildPiOptions(
      makeParsed({ maxTokens: 512 }),
      makeAuth(),
      "anthropic",
    );
    expect(opts.maxTokens).toBe(512);
  });

  test("propagates signal when provided", () => {
    const ctrl = new AbortController();
    const opts = buildPiOptions(
      makeParsed(),
      makeAuth(),
      "anthropic",
      ctrl.signal,
    );
    expect(opts.signal).toBe(ctrl.signal);
  });

  test("extracts sessionId from metadata.user_id", () => {
    const opts = buildPiOptions(
      makeParsed({ rawBody: { metadata: { user_id: "u-42" } } }),
      makeAuth(),
      "anthropic",
    );
    expect(opts.sessionId).toBe("u-42");
  });

  test("falls back to session_id when user_id missing", () => {
    const opts = buildPiOptions(
      makeParsed({ rawBody: { metadata: { session_id: "s-1" } } }),
      makeAuth(),
      "anthropic",
    );
    expect(opts.sessionId).toBe("s-1");
  });

  test("resolves anthropic OAuth from ANTHROPIC_OAUTH_TOKEN env var when apiKey empty", () => {
    process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token-123";
    const opts = buildPiOptions(
      makeParsed(),
      makeAuth({ apiKey: "" }),
      "anthropic",
    );
    expect(opts.apiKey).toBe("oauth-token-123");
  });
});
