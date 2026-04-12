import { describe, expect, test } from "bun:test";
import { BedrockAdapter } from "./bedrock.ts";
import type { AuthInfo, ParsedRequest } from "./types.ts";

const adapter = new BedrockAdapter();

const defaultAuth: AuthInfo = {
  apiKey: "AKIDEXAMPLE",
  headerName: "Authorization",
  headerValue: "",
  awsAccessKeyId: "AKIDEXAMPLE",
  awsSecretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  awsRegion: "us-east-1",
};

const legacyAuth: AuthInfo = {
  apiKey: "some-key",
  headerName: "Authorization",
  headerValue: "Bearer some-key",
};

describe("BedrockAdapter", () => {
  test("apiType is bedrock-converse-stream", () => {
    expect(adapter.apiType).toBe("bedrock-converse-stream");
  });

  describe("parseRequest", () => {
    test("extracts modelId and converts messages", () => {
      const body = {
        modelId: "anthropic.claude-3-sonnet",
        messages: [
          { role: "user", content: [{ text: "Hello" }] },
          { role: "assistant", content: [{ text: "Hi" }] },
        ],
      };

      const parsed = adapter.parseRequest(body);

      expect(parsed.model).toBe("anthropic.claude-3-sonnet");
      expect(parsed.messages).toEqual([
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ]);
      expect(parsed.stream).toBe(true);
    });

    test("extracts single system text", () => {
      const body = {
        modelId: "anthropic.claude-3-sonnet",
        messages: [],
        system: [{ text: "You are helpful" }],
      };

      const parsed = adapter.parseRequest(body);
      expect(parsed.system).toBe("You are helpful");
    });

    test("extracts multiple system texts as array", () => {
      const body = {
        modelId: "anthropic.claude-3-sonnet",
        messages: [],
        system: [{ text: "Be helpful" }, { text: "Be concise" }],
      };

      const parsed = adapter.parseRequest(body);
      expect(parsed.system).toEqual([
        { type: "text", text: "Be helpful" },
        { type: "text", text: "Be concise" },
      ]);
    });

    test("extracts maxTokens from inferenceConfig", () => {
      const body = {
        modelId: "anthropic.claude-3-sonnet",
        messages: [],
        inferenceConfig: { maxTokens: 4096 },
      };

      const parsed = adapter.parseRequest(body);
      expect(parsed.maxTokens).toBe(4096);
    });

    test("always sets stream to true", () => {
      const body = { modelId: "anthropic.claude-3-sonnet", messages: [] };
      const parsed = adapter.parseRequest(body);
      expect(parsed.stream).toBe(true);
    });

    test("handles string content in messages", () => {
      const body = {
        modelId: "anthropic.claude-3-sonnet",
        messages: [{ role: "user", content: "Hello" }],
      };

      const parsed = adapter.parseRequest(body);
      expect(parsed.messages[0].content).toBe("Hello");
    });

    test("handles missing messages", () => {
      const body = { modelId: "anthropic.claude-3-sonnet" };
      const parsed = adapter.parseRequest(body);
      expect(parsed.messages).toEqual([]);
    });
  });

  describe("buildUpstreamRequest", () => {
    const baseParsed: ParsedRequest = {
      model: "anthropic.claude-3-sonnet",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
      rawBody: {},
    };

    test("builds correct URL with model in path", () => {
      const result = adapter.buildUpstreamRequest(
        baseParsed,
        "anthropic.claude-3-5-sonnet-20241022-v2:0",
        "https://bedrock-runtime.us-east-1.amazonaws.com",
        defaultAuth,
      );

      expect(result.url).toBe(
        "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2:0/converse-stream",
      );
      expect(result.method).toBe("POST");
    });

    test("includes SigV4 auth headers when AWS credentials provided", () => {
      const result = adapter.buildUpstreamRequest(
        baseParsed,
        "anthropic.claude-3-sonnet",
        "https://bedrock-runtime.us-east-1.amazonaws.com",
        defaultAuth,
      );

      expect(result.headers["Authorization"]).toStartWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/");
      expect(result.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
      expect(result.headers["x-amz-content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
    });

    test("falls back to static auth when no AWS credentials", () => {
      const result = adapter.buildUpstreamRequest(
        baseParsed,
        "anthropic.claude-3-sonnet",
        "https://bedrock-runtime.us-east-1.amazonaws.com",
        legacyAuth,
      );

      expect(result.headers["Authorization"]).toBe("Bearer some-key");
      expect(result.headers["x-amz-date"]).toBeUndefined();
    });

    test("converts messages to Bedrock content block format", () => {
      const result = adapter.buildUpstreamRequest(
        baseParsed,
        "anthropic.claude-3-sonnet",
        "https://bedrock-runtime.us-east-1.amazonaws.com",
        defaultAuth,
      );

      const body = JSON.parse(result.body);
      expect(body.messages).toEqual([
        { role: "user", content: [{ text: "Hello" }] },
      ]);
      expect(body.modelId).toBeUndefined();
    });

    test("includes system in body when present (string)", () => {
      const withSystem = { ...baseParsed, system: "Be helpful" };
      const result = adapter.buildUpstreamRequest(
        withSystem,
        "anthropic.claude-3-sonnet",
        "https://bedrock-runtime.us-east-1.amazonaws.com",
        defaultAuth,
      );

      const body = JSON.parse(result.body);
      expect(body.system).toEqual([{ text: "Be helpful" }]);
    });

    test("includes system in body when present (array)", () => {
      const withSystem: ParsedRequest = {
        ...baseParsed,
        system: [
          { type: "text", text: "Be helpful" },
          { type: "text", text: "Be concise" },
        ],
      };
      const result = adapter.buildUpstreamRequest(
        withSystem,
        "anthropic.claude-3-sonnet",
        "https://bedrock-runtime.us-east-1.amazonaws.com",
        defaultAuth,
      );

      const body = JSON.parse(result.body);
      expect(body.system).toEqual([
        { text: "Be helpful" },
        { text: "Be concise" },
      ]);
    });

    test("includes maxTokens in inferenceConfig", () => {
      const withTokens = { ...baseParsed, maxTokens: 4096 };
      const result = adapter.buildUpstreamRequest(
        withTokens,
        "anthropic.claude-3-sonnet",
        "https://bedrock-runtime.us-east-1.amazonaws.com",
        defaultAuth,
      );

      const body = JSON.parse(result.body);
      expect(body.inferenceConfig.maxTokens).toBe(4096);
    });

    test("omits auth header when apiKey is empty", () => {
      const noAuth: AuthInfo = {
        apiKey: "",
        headerName: "",
        headerValue: "",
      };
      const result = adapter.buildUpstreamRequest(
        baseParsed,
        "anthropic.claude-3-sonnet",
        "https://bedrock-runtime.us-east-1.amazonaws.com",
        noAuth,
      );

      expect(result.headers["Authorization"]).toBeUndefined();
    });
  });

  describe("modifyMessages", () => {
    test("replaces messages with Bedrock content block format", () => {
      const rawBody = {
        modelId: "anthropic.claude-3-sonnet",
        messages: [{ role: "user", content: [{ text: "old" }] }],
        inferenceConfig: { maxTokens: 1024 },
      };

      const newMessages = [
        { role: "user", content: "compressed" },
        { role: "assistant", content: "response" },
      ];

      const result = adapter.modifyMessages(rawBody, newMessages);

      expect(result.messages).toEqual([
        { role: "user", content: [{ text: "compressed" }] },
        { role: "assistant", content: [{ text: "response" }] },
      ]);
      expect(result.inferenceConfig).toEqual({ maxTokens: 1024 });
    });

    test("preserves other fields", () => {
      const rawBody = {
        inferenceConfig: { temperature: 0.7 },
        messages: [],
      };

      const result = adapter.modifyMessages(rawBody, []);
      expect(result.inferenceConfig).toEqual({ temperature: 0.7 });
    });

    test("handles array content passthrough", () => {
      const newMessages = [
        {
          role: "user",
          content: [{ text: "part1" }, { text: "part2" }],
        },
      ];

      const result = adapter.modifyMessages({}, newMessages);
      expect(result.messages).toEqual([
        {
          role: "user",
          content: [{ text: "part1" }, { text: "part2" }],
        },
      ]);
    });
  });
});
