/** Handler function for a matched route */
export type RouteHandler = (req: Request, body: unknown) => Promise<Response>;

/** Server configuration */
export interface ServerConfig {
  port: number;
  host: string;
}

/** Server instance returned by createServer */
export interface ServerInstance {
  start(): void;
  stop(): void;
}

/** JSON response helper type */
export interface JsonResponse {
  status?: string;
  version?: string;
  message?: string;
  error?: string;
}
