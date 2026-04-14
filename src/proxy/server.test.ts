import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { createServer } from "./server.ts";
import { clearCustomHandlers, setRouteHandler } from "./router.ts";

const TEST_PORT = 19876;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

const server = createServer({ port: TEST_PORT, host: "127.0.0.1" });

beforeAll(() => {
  server.start();
});

afterAll(() => {
  server.stop();
});

afterEach(() => {
  clearCustomHandlers();
});

describe("GET /health", () => {
  test("returns 200 with status ok and version", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(body.version.length).toBeGreaterThan(0);
  });
});

describe("GET /v1/models", () => {
  test("returns OpenAI-compatible models list with auto model", async () => {
    const res = await fetch(`${BASE}/v1/models`);
    expect(res.status).toBe(200);
    const body = await res.json() as { object: string; data: Array<{ id: string; object: string; owned_by: string }> };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    const auto = body.data.find((m) => m.id === "auto");
    expect(auto).toBeDefined();
    expect(auto!.object).toBe("model");
    expect(auto!.owned_by).toBe("clawmux");
  });
});

describe("GET /stats", () => {
  test("returns 200 with stub message", async () => {
    const res = await fetch(`${BASE}/stats`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ message: "stats not implemented yet" });
  });
});

describe("POST stub routes return 501", () => {
  const stubRoutes = [
    { path: "/v1/messages", name: "anthropic" },
    { path: "/v1/chat/completions", name: "openai-completions" },
    { path: "/v1/responses", name: "openai-responses" },
  ];

  for (const { path, name } of stubRoutes) {
    test(`POST ${path} → 501 (${name})`, async () => {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ test: true }),
      });
      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body.error).toContain("not implemented");
    });
  }
});

describe("Google path matching", () => {
  test("POST /v1beta/models/gemini-pro:generateContent → 501", async () => {
    const res = await fetch(`${BASE}/v1beta/models/gemini-pro:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [] }),
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toContain("google");
  });

  test("POST /v1beta/models/gemini-1.5-flash:streamGenerateContent → 501", async () => {
    const res = await fetch(
      `${BASE}/v1beta/models/gemini-1.5-flash:streamGenerateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(501);
  });
});

describe("Ollama path matching", () => {
  test("POST /api/chat → 501", async () => {
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "llama3" }),
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toContain("ollama");
  });
});

describe("Bedrock path matching", () => {
  test("POST /model/anthropic.claude-v2/converse-stream → 501", async () => {
    const res = await fetch(`${BASE}/model/anthropic.claude-v2/converse-stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error).toContain("bedrock");
  });

  test("POST /model/meta.llama3-70b/converse-stream → 501", async () => {
    const res = await fetch(`${BASE}/model/meta.llama3-70b/converse-stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(501);
  });
});

describe("unknown route → 404", () => {
  test("GET /nonexistent → 404", async () => {
    const res = await fetch(`${BASE}/nonexistent`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("not found");
  });

  test("POST /unknown → 404", async () => {
    const res = await fetch(`${BASE}/unknown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("invalid JSON body → 400", () => {
  test("POST /v1/messages with malformed JSON → 400", async () => {
    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("invalid JSON");
  });
});

describe("setRouteHandler", () => {
  test("replaces stub handler for a route", async () => {
    setRouteHandler("/v1/messages", async (_req, body) => {
      return new Response(JSON.stringify({ custom: true, received: body }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await fetch(`${BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.custom).toBe(true);
    expect(body.received).toEqual({ hello: "world" });
  });
});
