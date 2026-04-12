import type { ServerConfig, ServerInstance } from "./types.ts";
import { dispatch } from "./router.ts";
import { isBun } from "../utils/runtime.ts";

export function createServer(config: ServerConfig): ServerInstance {
  if (isBun) {
    return createBunServer(config);
  }
  return createNodeServer(config);
}

function createBunServer(config: ServerConfig): ServerInstance {
  let server: { stop(close?: boolean): void } | null = null;

  return {
    start() {
      if (server) return;
      const bun = (globalThis as Record<string, unknown>).Bun as Record<string, Function>;
      server = bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: dispatch,
      }) as { stop(close?: boolean): void };
    },
    stop() {
      if (!server) return;
      server.stop(true);
      server = null;
    },
  };
}

function createNodeServer(config: ServerConfig): ServerInstance {
  let server: { close(): void } | null = null;

  return {
    async start() {
      if (server) return;
      const { createServer: createHttpServer } = await import("node:http");
      const { toWebRequest, writeWebResponse } = await import("./node-http-adapter.ts");

      const httpServer = createHttpServer(async (req, res) => {
        try {
          const webReq = toWebRequest(req);
          const webRes = await dispatch(webReq);
          await writeWebResponse(res, webRes);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        }
      });

      await new Promise<void>((resolve) => {
        httpServer.listen(config.port, config.host, resolve);
      });
      server = httpServer;
    },
    stop() {
      if (!server) return;
      server.close();
      server = null;
    },
  };
}
