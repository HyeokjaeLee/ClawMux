import { createServer } from "./proxy/server.ts";

const port = parseInt(process.env.CLAWMUX_PORT ?? "3456", 10);
const server = createServer({ port, host: "127.0.0.1" });
server.start();
console.log(`[clawmux] Proxy server running on http://127.0.0.1:${port}`);
