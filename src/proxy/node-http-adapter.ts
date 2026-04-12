import type { IncomingMessage, ServerResponse } from "node:http";

export function toWebRequest(req: IncomingMessage): Request {
  const protocol = "http";
  const host = req.headers.host ?? "localhost";
  const url = `${protocol}://${host}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const method = (req.method ?? "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const init: RequestInit & Record<string, unknown> = {
    method,
    headers,
    body: hasBody ? toReadableStream(req) : undefined,
  };
  if (hasBody) init.duplex = "half";

  return new Request(url, init);
}

function toReadableStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      req.on("end", () => controller.close());
      req.on("error", (err) => controller.error(err));
    },
  });
}

export async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const flushed = res.write(value);
      if (!flushed) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
  } finally {
    reader.releaseLock();
    res.end();
  }
}
