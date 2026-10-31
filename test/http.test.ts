import { afterEach, describe, expect, it, vi } from "vitest";
import { postChat } from "../src/client";
import { parseEnv, startGateway, type GatewayConfig } from "../src/gateway";
import { listenGateway } from "../src/node-listen";

const OFFLINE = "F.R.I.D.A.Y. is offline. Heard: ";

const offlineConfig: GatewayConfig = {
  allowAnyToken: true,
  gatewayToken: null,
  bridgeToken: null,
  bridgeUrl: "https://even-g2-bridge.saviormike.workers.dev",
};

const CORS = {
  origin: "*",
  methods: "GET, POST, OPTIONS",
  headers: "Content-Type, Authorization, X-Stark-Persona",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseEnv", () => {
  it("returns missing-gateway-token unless any-token mode is the string true", () => {
    expect(parseEnv({})).toEqual({ ok: false, error: "missing-gateway-token" });
    expect(parseEnv({ ALLOW_ANY_TOKEN: "TRUE" })).toEqual({ ok: false, error: "missing-gateway-token" });
    expect(parseEnv({ GATEWAY_TOKEN: "   " })).toEqual({ ok: false, error: "missing-gateway-token" });
    const allowed = parseEnv({ ALLOW_ANY_TOKEN: "true" });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.config.allowAnyToken).toBe(true);
    expect(allowed.config.bridgeUrl).toBe("https://even-g2-bridge.saviormike.workers.dev");
    const locked = parseEnv({ GATEWAY_TOKEN: "secret" });
    expect(locked.ok).toBe(true);
    if (!locked.ok) return;
    expect(locked.config.allowAnyToken).toBe(false);
    if (locked.config.allowAnyToken) return;
    expect(locked.config.gatewayToken).toBe("secret");
    expect(allowed.config.bridgeService).toBeNull();
    expect(allowed.config.elevenLabsApiKey).toBeNull();
    const keyed = parseEnv({ ALLOW_ANY_TOKEN: "true", ELEVENLABS_API_KEY: "  xi-key  " });
    expect(keyed.ok).toBe(true);
    if (!keyed.ok) return;
    expect(keyed.config.elevenLabsApiKey).toBe("xi-key");
  });

  it("turns anonymous stt on only for the string true and leaves the gateway locked", () => {
    const open = parseEnv({ GATEWAY_TOKEN: "secret", ALLOW_ANONYMOUS_STT: "true" });
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    expect(open.config.anonymousStt).toBe(true);
    expect(open.config.allowAnyToken).toBe(false);
    for (const value of [undefined, "", "TRUE", "1", "yes"]) {
      const closed = parseEnv({ GATEWAY_TOKEN: "secret", ALLOW_ANONYMOUS_STT: value });
      expect(closed.ok).toBe(true);
      if (!closed.ok) return;
      expect(closed.config.anonymousStt).toBe(false);
    }
    expect(parseEnv({ ALLOW_ANONYMOUS_STT: "true" })).toEqual({ ok: false, error: "missing-gateway-token" });
  });
});

describe("POST /api/chat", () => {
  it("answers OPTIONS with 204 CORS and an offline reply when no bridge token is set", async () => {
    const server = await listenGateway(startGateway(offlineConfig), { port: 0, staticDir: "dist" });
    try {
      for (const path of ["/api/chat", "/v1/chat/completions", "/api/stt/token"]) {
        const preflight = await fetch(`${server.url}${path}`, { method: "OPTIONS" });
        expect(preflight.status).toBe(204);
        expect(await preflight.text()).toBe("");
        expect(preflight.headers.get("access-control-allow-origin")).toBe(CORS.origin);
        expect(preflight.headers.get("access-control-allow-methods")).toBe(CORS.methods);
        expect(preflight.headers.get("access-control-allow-headers")).toBe(CORS.headers);
      }
      const friday = await fetch(`${server.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello", personaId: "friday" }),
      });
      expect(friday.status).toBe(200);
      expect(friday.headers.get("access-control-allow-origin")).toBe(CORS.origin);
      expect(friday.headers.get("access-control-allow-methods")).toBe(CORS.methods);
      expect(friday.headers.get("access-control-allow-headers")).toBe(CORS.headers);
      expect(await friday.json()).toEqual({
        ok: true,
        reply: `${OFFLINE}Hello`,
        model: "local-friday",
        personaId: "friday",
        routedToGrokBot: false,
      });
      const jarvis = await fetch(`${server.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello", personaId: "jarvis" }),
      });
      expect(await jarvis.json()).toMatchObject({
        reply: `${OFFLINE}Hello`,
        model: "local-friday",
        personaId: "jarvis",
        routedToGrokBot: false,
      });
      const doubled = await fetch(`${server.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "[Agent: J.A.R.V.I.S.] Hello", personaId: "jarvis" }),
      });
      expect(await doubled.json()).toMatchObject({
        reply: `${OFFLINE}Hello`,
      });
      const alias = await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ignored", messages: [{ role: "user", content: "Hello" }] }),
      });
      const completion = (await alias.json()) as { choices: { message: { content: string } }[] };
      expect(alias.headers.get("access-control-allow-origin")).toBe(CORS.origin);
      expect(completion.choices[0]?.message.content).toBe(`${OFFLINE}Hello`);
      const health = await fetch(`${server.url}/health`);
      expect(await health.json()).toEqual({
        ok: true,
        service: "stark-r1-openclaw",
        protocolMin: 3,
        protocolMax: 4,
      });
    } finally {
      await server.close();
    }
  });

  it("forwards model grok to the bridge and fails closed without throwing", async () => {
    const calls: { url: string; authorization: string; body: { model: string; messages: { role: string; content: string }[] } }[] = [];
    const host = startGateway({
      allowAnyToken: true,
      gatewayToken: null,
      bridgeToken: "bridge-secret",
      bridgeUrl: "https://even-g2-bridge.saviormike.workers.dev/",
    });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        authorization: String(new Headers(init?.headers).get("authorization")),
        body: JSON.parse(String(init?.body)) as { model: string; messages: { role: string; content: string }[] },
      });
      return new Response(
        JSON.stringify({ model: "grok-2", choices: [{ message: { content: "Online." } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const served = await host.receive({
      method: "POST",
      path: "/api/chat",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Hello",
        personaId: "jarvis",
        history: [{ role: "user", content: "Earlier" }],
      }),
    });
    expect(served.kind).toBe("respond");
    if (served.kind !== "respond" || served.response.body === null) throw new Error("expected a body");
    expect(JSON.parse(served.response.body)).toEqual({
      ok: true,
      reply: "Online.",
      model: "grok-2",
      personaId: "jarvis",
      routedToGrokBot: true,
    });
    expect(calls).toEqual([
      {
        url: "https://even-g2-bridge.saviormike.workers.dev/v1/chat/completions",
        authorization: "Bearer bridge-secret",
        body: {
          model: "grok",
          messages: [
            { role: "user", content: "Earlier" },
            { role: "user", content: "Hello" },
          ],
        },
      },
    ]);

    vi.stubGlobal("fetch", () => Promise.reject(new Error("down")));
    const thrown = await host.receive({
      method: "POST",
      path: "/api/chat",
      headers: {},
      body: JSON.stringify({ message: "Hello", personaId: "friday" }),
    });
    expect(thrown.kind === "respond" && thrown.response.body && JSON.parse(thrown.response.body).reply).toBe(`${OFFLINE}Hello`);

    vi.stubGlobal("fetch", async () => new Response("nope", { status: 503 }));
    const failed = await host.receive({
      method: "POST",
      path: "/api/chat",
      headers: {},
      body: JSON.stringify({ message: "Hello", personaId: "friday" }),
    });
    expect(failed.kind === "respond" && failed.response.body && JSON.parse(failed.response.body).reply).toBe(`${OFFLINE}Hello`);

    vi.stubGlobal("fetch", async () => new Response("not-json", { status: 200 }));
    const bad = await host.receive({
      method: "POST",
      path: "/api/chat",
      headers: {},
      body: JSON.stringify({ message: "Hello", personaId: "friday" }),
    });
    expect(bad.kind === "respond" && bad.response.body && JSON.parse(bad.response.body)).toMatchObject({
      reply: `${OFFLINE}Hello`,
      model: "local-friday",
      routedToGrokBot: false,
    });

    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ model: "local-friday", choices: [{ message: { content: "nope" } }] }), {
          status: 200,
        }),
    );
    const localModel = await host.receive({
      method: "POST",
      path: "/api/chat",
      headers: {},
      body: JSON.stringify({ message: "Hello", personaId: "friday" }),
    });
    expect(localModel.kind === "respond" && localModel.response.body && JSON.parse(localModel.response.body)).toMatchObject({
      model: "local-friday",
      routedToGrokBot: false,
      reply: `${OFFLINE}Hello`,
    });
  });
});

describe("postChat", () => {
  it("posts the utterance without an agent name", async () => {
    const bodies: { message: string; history: { content: string }[] }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe("/api/chat");
      bodies.push(JSON.parse(String(init?.body)) as { message: string; history: { content: string }[] });
      return new Response(
        JSON.stringify({
          ok: true,
          reply: "Hi",
          model: "local-friday",
          personaId: "jarvis",
          routedToGrokBot: false,
        }),
      );
    });
    const first = await postChat({ message: "Hello", personaId: "jarvis", history: [], token: null });
    const second = await postChat({
      message: "[R1 -> J.A.R.V.I.S.] Hello",
      personaId: "jarvis",
      history: [{ role: "user", content: "Hello" }],
      token: null,
    });
    expect(first).toMatchObject({ ok: true, reply: "Hi", model: "local-friday", routedToGrokBot: false });
    expect(second.ok).toBe(true);
    expect(bodies.map((body) => body.message)).toEqual(["Hello", "Hello"]);
    expect(bodies.some((body) => body.message.includes("J.A.R.V.I.S."))).toBe(false);
    expect(bodies[1]?.history).toEqual([{ role: "user", content: "Hello" }]);
  });
});

const BRIDGE = "https://even-g2-bridge.saviormike.workers.dev";
const COMPLETIONS = `${BRIDGE}/v1/chat/completions`;

function chatRequest(message = "Hello"): {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
} {
  return {
    method: "POST",
    path: "/api/chat",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, personaId: "friday" }),
  };
}

function online(text: string): Response {
  return new Response(JSON.stringify({ model: "grok-2", choices: [{ message: { content: text } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function readReply(served: Awaited<ReturnType<ReturnType<typeof startGateway>["receive"]>>): { reply?: string; error?: string; ok?: boolean; token?: string } {
  if (served.kind !== "respond" || served.response.body === null) throw new Error("expected a body");
  return JSON.parse(served.response.body) as { reply?: string; error?: string; ok?: boolean; token?: string };
}

describe("bridge lane", () => {
  it("uses the request binding for chat and keeps global fetch for a null lane", async () => {
    const seen: { who: string; url: string; authorization: string | null }[] = [];
    const service = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          who: "binding",
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return online("Bound.");
      },
    };
    const cached = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          who: "cached",
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return online("Cached.");
      },
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        who: "global",
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return online("Global.");
    });
    const host = startGateway({
      allowAnyToken: true,
      gatewayToken: null,
      bridgeToken: "bridge-secret",
      bridgeUrl: `${BRIDGE}/`,
      bridgeService: cached,
    });
    const inherited = await host.receive(chatRequest());
    expect(readReply(inherited).reply).toBe("Cached.");
    const bound = await host.receive(chatRequest(), { tag: "request", service });
    expect(readReply(bound).reply).toBe("Bound.");
    const cleared = await host.receive(chatRequest(), { tag: "request", service: null });
    expect(readReply(cleared).reply).toBe("Global.");
    expect(seen).toEqual([
      { who: "cached", url: COMPLETIONS, authorization: "Bearer bridge-secret" },
      { who: "binding", url: COMPLETIONS, authorization: "Bearer bridge-secret" },
      { who: "global", url: COMPLETIONS, authorization: "Bearer bridge-secret" },
    ]);
  });

  it("keeps a device token on the host when a later request changes only the fetcher", async () => {
    const seen: string[] = [];
    const serviceA = {
      fetch: async (input: RequestInfo | URL) => {
        seen.push(`A ${String(input)}`);
        return online("from-a");
      },
    };
    const serviceB = {
      fetch: async (input: RequestInfo | URL) => {
        seen.push(`B ${String(input)}`);
        return online("from-b");
      },
    };
    const host = startGateway({
      allowAnyToken: false,
      gatewayToken: "gate",
      bridgeToken: "bridge-secret",
      bridgeUrl: BRIDGE,
    });
    const upgraded = await host.receive(
      { method: "GET", path: "/openclaw/ws", headers: { upgrade: "websocket" }, body: null },
      { tag: "request", service: serviceA },
    );
    expect(upgraded.kind).toBe("upgrade");
    if (upgraded.kind !== "upgrade") return;
    const first = socketPort();
    upgraded.attach(first.port);
    first.receive(JSON.stringify({
      type: "req",
      id: "c1",
      method: "connect",
      params: { minProtocol: 3, maxProtocol: 4, auth: { token: "gate" } },
    }));
    const hello = JSON.parse(first.sent.at(-1) ?? "{}") as { ok?: boolean; payload?: { auth?: { deviceToken?: string } } };
    expect(hello.ok).toBe(true);
    const deviceToken = hello.payload?.auth?.deviceToken;
    expect(deviceToken).toMatch(/^[0-9a-f]{64}$/);
    first.receive(JSON.stringify({
      type: "req",
      id: "t1",
      method: "chat.send",
      params: { message: "Status" },
    }));
    await vi.waitFor(() => expect(seen).toEqual([`A ${COMPLETIONS}`]));

    const again = await host.receive(
      { method: "GET", path: "/openclaw/ws", headers: { upgrade: "websocket" }, body: null },
      { tag: "request", service: serviceB },
    );
    expect(again.kind).toBe("upgrade");
    if (again.kind !== "upgrade") return;
    const second = socketPort();
    again.attach(second.port);
    second.receive(JSON.stringify({
      type: "req",
      id: "c2",
      method: "connect",
      params: { minProtocol: 3, maxProtocol: 4, auth: { deviceToken } },
    }));
    const remembered = JSON.parse(second.sent.at(-1) ?? "{}") as { ok?: boolean };
    expect(remembered.ok).toBe(true);
    second.receive(JSON.stringify({
      type: "req",
      id: "t2",
      method: "chat.send",
      params: { message: "Again" },
    }));
    await vi.waitFor(() => expect(seen).toEqual([`A ${COMPLETIONS}`, `B ${COMPLETIONS}`]));
    first.stop();
    second.stop();
  });
});

describe("POST /api/stt/token", () => {
  it("mints with the gateway or bridge bearer and does not authorize /api/chat", async () => {
    const calls: { url: string; key: string | null }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), key: new Headers(init?.headers).get("xi-api-key") });
      return new Response(JSON.stringify({ token: "scribe-token" }), { status: 200 });
    });
    const host = startGateway({
      allowAnyToken: false,
      gatewayToken: "gate",
      bridgeToken: "bridge-secret",
      bridgeUrl: BRIDGE,
      elevenLabsApiKey: "xi-key",
      bridgeService: {
        fetch: async () => {
          throw new Error("binding");
        },
      },
    });
    const denied = await host.receive({
      method: "POST",
      path: "/api/stt/token",
      headers: { authorization: "Bearer other" },
      body: null,
    });
    expect(denied.kind).toBe("respond");
    if (denied.kind !== "respond") return;
    expect(denied.response.status).toBe(401);
    expect(denied.response.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(readReply(denied)).toEqual({ ok: false, error: "unauthorized" });
    expect(calls).toEqual([]);

    const fromHeader = await host.receive({
      method: "POST",
      path: "/api/stt/token",
      headers: { authorization: "Bearer gate" },
      body: "{",
    });
    expect(readReply(fromHeader)).toEqual({ ok: true, token: "scribe-token" });
    const fromBody = await host.receive({
      method: "POST",
      path: "/api/stt/token",
      headers: {},
      body: JSON.stringify({ token: "bridge-secret" }),
    });
    expect(readReply(fromBody)).toEqual({ ok: true, token: "scribe-token" });
    expect(calls).toEqual([
      { url: "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", key: "xi-key" },
      { url: "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", key: "xi-key" },
    ]);

    const chat = await host.receive({
      method: "POST",
      path: "/api/chat",
      headers: {},
      body: JSON.stringify({ message: "Hello", personaId: "friday" }),
    });
    expect(chat.kind).toBe("respond");
    if (chat.kind !== "respond") return;
    expect(chat.response.status).toBe(200);
    expect(readReply(chat).reply).toBe(`${OFFLINE}Hello`);
  });

  it("mints without any token only when anonymous stt is on", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ token: "scribe-token" }), { status: 200 }));
    const base = {
      allowAnyToken: false as const,
      gatewayToken: "gate",
      bridgeToken: "bridge-secret",
      bridgeUrl: BRIDGE,
      elevenLabsApiKey: "xi-key",
    };
    const bare = { method: "POST", path: "/api/stt/token", headers: {}, body: null };
    const locked = await startGateway(base).receive(bare);
    expect(readReply(locked)).toEqual({ ok: false, error: "unauthorized" });
    const open = startGateway({ ...base, anonymousStt: true });
    expect(readReply(await open.receive(bare))).toEqual({ ok: true, token: "scribe-token" });
    const wrong = await open.receive({ ...bare, headers: { authorization: "Bearer other" } });
    expect(readReply(wrong)).toEqual({ ok: true, token: "scribe-token" });
    const noKey = startGateway({ ...base, anonymousStt: true, elevenLabsApiKey: null });
    expect(readReply(await noKey.receive(bare))).toEqual({ ok: false, error: "stt-unconfigured" });
  });

  it("reports a missing key and an upstream failure", async () => {
    const unconfigured = startGateway({
      allowAnyToken: true,
      gatewayToken: null,
      bridgeToken: null,
      bridgeUrl: BRIDGE,
    });
    const missing = await unconfigured.receive({ method: "POST", path: "/api/stt/token", headers: {}, body: null });
    expect(missing.kind).toBe("respond");
    if (missing.kind !== "respond") return;
    expect(missing.response.status).toBe(503);
    expect(missing.response.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(readReply(missing)).toEqual({ ok: false, error: "stt-unconfigured" });

    const host = startGateway({
      allowAnyToken: true,
      gatewayToken: null,
      bridgeToken: null,
      bridgeUrl: BRIDGE,
      elevenLabsApiKey: "xi-key",
    });
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const failed = await host.receive({ method: "POST", path: "/api/stt/token", headers: {}, body: null });
    expect(failed.kind).toBe("respond");
    if (failed.kind !== "respond") return;
    expect(failed.response.status).toBe(502);
    expect(readReply(failed)).toEqual({ ok: false, error: "stt-upstream-failed" });

    vi.stubGlobal("fetch", async () => new Response("not-json", { status: 200 }));
    const bad = await host.receive({ method: "POST", path: "/api/stt/token", headers: {}, body: null });
    expect(readReply(bad)).toEqual({ ok: false, error: "stt-upstream-failed" });

    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ token: "  " }), { status: 200 }));
    const empty = await host.receive({ method: "POST", path: "/api/stt/token", headers: {}, body: null });
    expect(readReply(empty)).toEqual({ ok: false, error: "stt-upstream-failed" });

    vi.stubGlobal("fetch", () => Promise.reject(new Error("down")));
    const thrown = await host.receive({ method: "POST", path: "/api/stt/token", headers: {}, body: null });
    expect(readReply(thrown)).toEqual({ ok: false, error: "stt-upstream-failed" });
  });
});

function socketPort(): {
  port: {
    send(text: string): void;
    close(reason: string): void;
    onText(handler: (text: string) => void): void;
    onClose(handler: () => void): void;
  };
  sent: string[];
  receive(text: string): void;
  stop(): void;
} {
  const sent: string[] = [];
  let onText: (text: string) => void = () => {};
  let onClose: () => void = () => {};
  return {
    sent,
    port: {
      send(text) {
        sent.push(text);
      },
      close() {},
      onText(handler) {
        onText = handler;
      },
      onClose(handler) {
        onClose = handler;
      },
    },
    receive(text) {
      onText(text);
    },
    stop() {
      onClose();
    },
  };
}
