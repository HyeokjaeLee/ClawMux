import type { RouteHandler } from "./types.ts";

const VERSION = "0.1.0";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubNotImplemented(name: string): RouteHandler {
  return async () =>
    jsonResponse({ error: `${name} not implemented yet` }, 501);
}

interface RouteEntry {
  method: string;
  match: (pathname: string) => boolean;
  handler: RouteHandler;
  key: string;
}

const customHandlers = new Map<string, RouteHandler>();

const routes: RouteEntry[] = [
  {
    method: "GET",
    match: (p) => p === "/health",
    handler: async () => jsonResponse({ status: "ok", version: VERSION }),
    key: "/health",
  },
  {
    method: "GET",
    match: (p) => p === "/stats",
    handler: async () => jsonResponse({ message: "stats not implemented yet" }),
    key: "/stats",
  },
  {
    method: "POST",
    match: (p) => p === "/v1/messages",
    handler: stubNotImplemented("anthropic"),
    key: "/v1/messages",
  },
  {
    method: "POST",
    match: (p) => p === "/v1/chat/completions",
    handler: stubNotImplemented("openai-completions"),
    key: "/v1/chat/completions",
  },
  {
    method: "POST",
    match: (p) => p === "/v1/responses",
    handler: stubNotImplemented("openai-responses"),
    key: "/v1/responses",
  },
  {
    method: "POST",
    match: (p) => p.startsWith("/v1beta/models/"),
    handler: stubNotImplemented("google"),
    key: "/v1beta/models/*",
  },
  {
    method: "POST",
    match: (p) => p === "/api/chat",
    handler: stubNotImplemented("ollama"),
    key: "/api/chat",
  },
  {
    method: "POST",
    match: (p) => p.startsWith("/model/") && p.endsWith("/converse-stream"),
    handler: stubNotImplemented("bedrock"),
    key: "/model/*/converse-stream",
  },
];

async function parseJsonBody(req: Request): Promise<{ body: unknown; error: Response | null }> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return { body: null, error: null };
  }

  try {
    const text = await req.text();
    if (text.length === 0) {
      return { body: null, error: null };
    }
    return { body: JSON.parse(text), error: null };
  } catch {
    return {
      body: null,
      error: jsonResponse({ error: "invalid JSON body" }, 400),
    };
  }
}

export async function dispatch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method.toUpperCase();

  for (const route of routes) {
    if (route.method === method && route.match(pathname)) {
      const handler = customHandlers.get(route.key) ?? route.handler;

      if (method === "POST") {
        const { body, error } = await parseJsonBody(req);
        if (error) return error;
        return handler(req, body);
      }

      return handler(req, null);
    }
  }

  return jsonResponse({ error: "not found" }, 404);
}

export function setRouteHandler(path: string, handler: RouteHandler): void {
  customHandlers.set(path, handler);
}

export function clearCustomHandlers(): void {
  customHandlers.clear();
}
