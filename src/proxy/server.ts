import type { ServerConfig, ServerInstance } from "./types.ts";
import { dispatch } from "./router.ts";

export function createServer(config: ServerConfig): ServerInstance {
  let server: ReturnType<typeof Bun.serve> | null = null;

  return {
    start() {
      if (server) return;
      server = Bun.serve({
        port: config.port,
        hostname: config.host,
        fetch: dispatch,
      });
    },
    stop() {
      if (!server) return;
      server.stop(true);
      server = null;
    },
  };
}
