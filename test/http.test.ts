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
  });
});

describe("POST /api/chat", () => {
  it("answers OPTIONS with 204 CORS and an offline reply when no bridge token is set", async () => {
    const server = await listenGateway(startGateway(offlineConfig), { port: 0, staticDir: "dist" });
    try {
      for (const path of ["/api/chat", "/v1/chat/completions"]) {
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
        reply: `${OFFLINE}[Agent: J.A.R.V.I.S.] Hello`,
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
        reply: `${OFFLINE}[Agent: J.A.R.V.I.S.] Hello`,
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
            { role: "user", content: "[Agent: J.A.R.V.I.S.] Hello" },
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
  it("applies the R1 prefix once and leaves an existing prefix in place", async () => {
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
    expect(bodies.map((body) => body.message)).toEqual([
      "[R1 -> J.A.R.V.I.S.] Hello",
      "[R1 -> J.A.R.V.I.S.] Hello",
    ]);
    expect(bodies[1]?.history).toEqual([{ role: "user", content: "Hello" }]);
  });
});
