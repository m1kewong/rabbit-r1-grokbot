import {
  parseEnv,
  startGateway,
  type GatewayBindings,
  type GatewayHost,
  type HttpRequest,
  type HttpResponse,
  type SocketPort,
} from "./gateway";

export type WorkerBindings = GatewayBindings & {
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
};

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

type AcceptedSocket = WebSocket & { accept(): void };

let host: GatewayHost | undefined;

function toSocket(ws: AcceptedSocket): SocketPort {
  let onText: (text: string) => void = () => {};
  let onClose: () => void = () => {};
  ws.addEventListener("message", (event: MessageEvent) => {
    onText(typeof event.data === "string" ? event.data : "");
  });
  ws.addEventListener("close", () => onClose());
  return {
    send(text) {
      ws.send(text);
    },
    close() {
      ws.close();
    },
    onText(handler) {
      onText = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
  };
}

async function toHttp(request: Request): Promise<HttpRequest> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const upgrade = (headers.upgrade ?? "").toLowerCase() === "websocket";
  const skipBody = upgrade || request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
  return {
    method: request.method,
    path: url.pathname,
    headers,
    body: skipBody ? null : await request.text(),
  };
}

function toResponse(response: HttpResponse): Response {
  return new Response(response.body, { status: response.status, headers: response.headers });
}

function adopt(attach: (socket: SocketPort) => void): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1] as AcceptedSocket;
  server.accept();
  attach(toSocket(server));
  return new Response(null, { status: 101, webSocket: client } as ResponseInit);
}

async function serveStatic(request: Request, env: WorkerBindings): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  if (asset.status !== 404) return asset;
  const url = new URL(request.url);
  url.pathname = "/index.html";
  return env.ASSETS.fetch(new Request(url, request));
}

const worker = {
  async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    const parsed = parseEnv(env);
    if (!parsed.ok) return new Response(parsed.error, { status: 500 });
    host ??= startGateway(parsed.config);
    const served = await host.receive(await toHttp(request), {
      tag: "request",
      service: env.EVEN_G2_BRIDGE ?? null,
    });
    if (served.kind === "upgrade") return adopt(served.attach);
    if (served.kind === "respond") return toResponse(served.response);
    return serveStatic(request, env);
  },
};

export default worker;
