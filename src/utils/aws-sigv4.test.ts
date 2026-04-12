import { describe, expect, test } from "bun:test";
import { signRequest, extractRegionFromUrl } from "./aws-sigv4.ts";
import type { AwsCredentials, SignableRequest } from "./aws-sigv4.ts";

const TEST_CREDENTIALS: AwsCredentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
};

const FIXED_DATE = new Date("2025-04-13T12:00:00.000Z");

const BASE_REQUEST: SignableRequest = {
  method: "POST",
  url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-sonnet/converse-stream",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages: [{ role: "user", content: [{ text: "Hello" }] }] }),
};

describe("signRequest", () => {
  test("returns Authorization header with AWS4-HMAC-SHA256 prefix", () => {
    const result = signRequest(BASE_REQUEST, TEST_CREDENTIALS, FIXED_DATE);

    expect(result.Authorization).toStartWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/");
  });

  test("Authorization contains credential scope with region and service", () => {
    const result = signRequest(BASE_REQUEST, TEST_CREDENTIALS, FIXED_DATE);

    expect(result.Authorization).toContain("20250413/us-east-1/bedrock/aws4_request");
  });

  test("Authorization contains SignedHeaders", () => {
    const result = signRequest(BASE_REQUEST, TEST_CREDENTIALS, FIXED_DATE);

    expect(result.Authorization).toContain("SignedHeaders=");
    expect(result.Authorization).toContain("host");
    expect(result.Authorization).toContain("x-amz-date");
    expect(result.Authorization).toContain("x-amz-content-sha256");
  });

  test("Authorization contains Signature (64 hex chars)", () => {
    const result = signRequest(BASE_REQUEST, TEST_CREDENTIALS, FIXED_DATE);

    const signatureMatch = result.Authorization.match(/Signature=([a-f0-9]+)/);
    expect(signatureMatch).not.toBeNull();
    expect(signatureMatch![1].length).toBe(64);
  });

  test("includes x-amz-date header", () => {
    const result = signRequest(BASE_REQUEST, TEST_CREDENTIALS, FIXED_DATE);

    expect(result["x-amz-date"]).toBe("20250413T120000Z");
  });

  test("includes x-amz-content-sha256 header (64 hex chars)", () => {
    const result = signRequest(BASE_REQUEST, TEST_CREDENTIALS, FIXED_DATE);

    expect(result["x-amz-content-sha256"]).toMatch(/^[a-f0-9]{64}$/);
  });

  test("does not include x-amz-security-token when no session token", () => {
    const result = signRequest(BASE_REQUEST, TEST_CREDENTIALS, FIXED_DATE);

    expect(result["x-amz-security-token"]).toBeUndefined();
  });

  test("includes x-amz-security-token when session token provided", () => {
    const credsWithToken: AwsCredentials = {
      ...TEST_CREDENTIALS,
      sessionToken: "FwoGZXIvYXdzEBYaDH+SESSION+TOKEN",
    };

    const result = signRequest(BASE_REQUEST, credsWithToken, FIXED_DATE);

    expect(result["x-amz-security-token"]).toBe("FwoGZXIvYXdzEBYaDH+SESSION+TOKEN");
    expect(result.Authorization).toContain("x-amz-security-token");
  });

  test("produces deterministic output for same inputs", () => {
    const result1 = signRequest(BASE_REQUEST, TEST_CREDENTIALS, FIXED_DATE);
    const result2 = signRequest(BASE_REQUEST, TEST_CREDENTIALS, FIXED_DATE);

    expect(result1.Authorization).toBe(result2.Authorization);
    expect(result1["x-amz-content-sha256"]).toBe(result2["x-amz-content-sha256"]);
  });

  test("different body produces different signature", () => {
    const altRequest: SignableRequest = {
      ...BASE_REQUEST,
      body: JSON.stringify({ messages: [{ role: "user", content: [{ text: "Different" }] }] }),
    };

    const result1 = signRequest(BASE_REQUEST, TEST_CREDENTIALS, FIXED_DATE);
    const result2 = signRequest(altRequest, TEST_CREDENTIALS, FIXED_DATE);

    expect(result1.Authorization).not.toBe(result2.Authorization);
  });

  test("different date produces different signature", () => {
    const date1 = new Date("2025-04-13T12:00:00.000Z");
    const date2 = new Date("2025-04-14T12:00:00.000Z");

    const result1 = signRequest(BASE_REQUEST, TEST_CREDENTIALS, date1);
    const result2 = signRequest(BASE_REQUEST, TEST_CREDENTIALS, date2);

    expect(result1.Authorization).not.toBe(result2.Authorization);
  });

  test("different region produces different signature", () => {
    const altCreds: AwsCredentials = { ...TEST_CREDENTIALS, region: "eu-west-1" };

    const result1 = signRequest(BASE_REQUEST, TEST_CREDENTIALS, FIXED_DATE);
    const result2 = signRequest(BASE_REQUEST, altCreds, FIXED_DATE);

    expect(result1.Authorization).not.toBe(result2.Authorization);
    expect(result2.Authorization).toContain("eu-west-1/bedrock");
  });

  test("handles URL with model version containing colon", () => {
    const request: SignableRequest = {
      ...BASE_REQUEST,
      url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet-20241022-v2:0/converse-stream",
    };

    const result = signRequest(request, TEST_CREDENTIALS, FIXED_DATE);

    expect(result.Authorization).toStartWith("AWS4-HMAC-SHA256 Credential=");
    expect(result["x-amz-date"]).toBe("20250413T120000Z");
  });
});

describe("extractRegionFromUrl", () => {
  test("extracts region from standard Bedrock endpoint", () => {
    expect(extractRegionFromUrl("https://bedrock-runtime.us-east-1.amazonaws.com")).toBe("us-east-1");
  });

  test("extracts region from eu-west-1", () => {
    expect(extractRegionFromUrl("https://bedrock-runtime.eu-west-1.amazonaws.com")).toBe("eu-west-1");
  });

  test("extracts region from ap-northeast-1", () => {
    expect(extractRegionFromUrl("https://bedrock-runtime.ap-northeast-1.amazonaws.com")).toBe("ap-northeast-1");
  });

  test("returns undefined for non-AWS URL", () => {
    expect(extractRegionFromUrl("https://api.anthropic.com")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(extractRegionFromUrl("")).toBeUndefined();
  });

  test("handles URL with path", () => {
    expect(extractRegionFromUrl("https://bedrock-runtime.us-west-2.amazonaws.com/model/foo/converse-stream")).toBe("us-west-2");
  });
});
