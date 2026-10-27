import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { LIMITS, type GatewayHost, type HttpRequest, type HttpResponse, type SocketPort } from "./gateway";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function headerMap(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(", ");
  }
  return headers;
}

async function toHttp(req: IncomingMessage, readBody: boolean): Promise<HttpRequest> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let body: string | null = null;
  if (readBody) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    body = Buffer.concat(chunks).toString("utf8");
  }
  return { method: req.method ?? "GET", path: url.pathname, headers: headerMap(req), body };
}

function writeHttp(res: ServerResponse, response: HttpResponse): void {
  res.writeHead(response.status, response.headers);
  if (response.body === null) res.end();
  else res.end(response.body);
}

function rawText(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

function adaptSocket(ws: WebSocket): SocketPort {
  let handler: ((text: string) => void) | null = null;
  let onClose = (): void => {};
  const queued: string[] = [];
  ws.on("message", (data) => {
    const text = rawText(data);
    if (handler) handler(text);
    else queued.push(text);
  });
  ws.on("close", () => onClose());
  return {
    send(text) {
      if (ws.bufferedAmount > LIMITS.maxBufferedBytes) {
        ws.close(1009, "max-buffered");
        return;
      }
      ws.send(text);
    },
    close(reason) {
      ws.close(1000, reason);
    },
    onText(next) {
      handler = next;
      for (const text of queued.splice(0)) next(text);
    },
    onClose(next) {
      onClose = next;
    },
  };
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function contained(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

async function pipeStatic(res: ServerResponse, root: string, urlPath: string): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    decoded = "/";
  }
  const requested = resolve(root, decoded.replace(/^\/+/, ""));
  const index = join(root, "index.html");
  const file = contained(root, requested) && (await isFile(requested)) ? requested : index;
  try {
    const body = await readFile(file);
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

export async function listenGateway(
  host: GatewayHost,
  options: { readonly port: number; readonly staticDir: string },
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const root = resolve(options.staticDir);
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxPayload, perMessageDeflate: false });
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const upgrade = (req.headers.upgrade ?? "").toLowerCase() === "websocket";
        const request = await toHttp(req, !upgrade && req.method !== "GET" && req.method !== "HEAD");
        const served = await host.receive(request);
        if (served.kind === "respond") {
          writeHttp(res, served.response);
          return;
        }
        if (served.kind === "static") {
          await pipeStatic(res, root, request.path);
          return;
        }
        writeHttp(res, { status: 426, headers: { "content-type": "text/plain; charset=utf-8" }, body: "upgrade required" });
      } catch {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("error");
        }
      }
    })();
  });
  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      try {
        const request = await toHttp(req, false);
        const served = await host.receive(request);
        if (served.kind !== "upgrade") {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          sockets.add(ws);
          ws.on("close", () => sockets.delete(ws));
          served.attach(adaptSocket(ws));
        });
      } catch {
        socket.destroy();
      }
    })();
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.terminate();
      wss.close();
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}
