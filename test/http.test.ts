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
    expect(keyed.config.ttsVoiceId).toBeNull();
    const voiced = parseEnv({ ALLOW_ANY_TOKEN: "true", ELEVENLABS_TTS_VOICE_ID: "  voice-9  " });
    expect(voiced.ok).toBe(true);
    if (!voiced.ok) return;
    expect(voiced.config.ttsVoiceId).toBe("voice-9");
    const blankVoice = parseEnv({ ALLOW_ANY_TOKEN: "true", ELEVENLABS_TTS_VOICE_ID: "   " });
    expect(blankVoice.ok).toBe(true);
    if (!blankVoice.ok) return;
    expect(blankVoice.config.ttsVoiceId).toBeNull();
  });
});

describe("POST /api/chat", () => {
  it("answers OPTIONS with 204 CORS and an offline reply when no bridge token is set", async () => {
    const server = await listenGateway(startGateway(offlineConfig), { port: 0, staticDir: "dist" });
    try {
      for (const path of ["/api/chat", "/v1/chat/completions", "/api/stt/token", "/api/tts"]) {
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
    if (served.kind !== "respond" || typeof served.response.body !== "string") throw new Error("expected a body");
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
    expect(thrown.kind === "respond" && typeof thrown.response.body === "string" && JSON.parse(thrown.response.body).reply).toBe(`${OFFLINE}Hello`);

    vi.stubGlobal("fetch", async () => new Response("nope", { status: 503 }));
    const failed = await host.receive({
      method: "POST",
      path: "/api/chat",
      headers: {},
      body: JSON.stringify({ message: "Hello", personaId: "friday" }),
    });
    expect(failed.kind === "respond" && typeof failed.response.body === "string" && JSON.parse(failed.response.body).reply).toBe(`${OFFLINE}Hello`);

    vi.stubGlobal("fetch", async () => new Response("not-json", { status: 200 }));
    const bad = await host.receive({
      method: "POST",
      path: "/api/chat",
      headers: {},
      body: JSON.stringify({ message: "Hello", personaId: "friday" }),
    });
    expect(bad.kind === "respond" && typeof bad.response.body === "string" && JSON.parse(bad.response.body)).toMatchObject({
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
    expect(localModel.kind === "respond" && typeof localModel.response.body === "string" && JSON.parse(localModel.response.body)).toMatchObject({
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
  if (served.kind !== "respond" || typeof served.response.body !== "string") throw new Error("expected a body");
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

const DEFAULT_VOICE = "3b8fXc91YHS1i2DYAlBQ";
const TTS_MPEG = Uint8Array.from([9, 8, 7, 6]);

function ttsRequest(text: string): { method: string; path: string; headers: Record<string, string>; body: string } {
  return {
    method: "POST",
    path: "/api/tts",
    headers: {},
    body: JSON.stringify({ text, voice: "other", model_id: "eleven_turbo", language_code: "en" }),
  };
}

function responseText(body: string | Uint8Array | null): string {
  if (body === null) return "";
  if (typeof body === "string") return body;
  return Buffer.from(body).toString("utf8");
}

function responseDump(response: { status: number; headers: Readonly<Record<string, string>>; body: string | Uint8Array | null }): string {
  return `${response.status}\n${JSON.stringify(response.headers)}\n${responseText(response.body)}`;
}

function ttsHost(source: Parameters<typeof parseEnv>[0]): ReturnType<typeof startGateway> {
  const parsed = parseEnv(source);
  if (!parsed.ok) throw new Error(parsed.error);
  return startGateway({
    ...parsed.config,
    bridgeService: {
      fetch: async () => {
        throw new Error("binding");
      },
    },
  });
}

describe("POST /api/tts", () => {
  it("does not fetch ElevenLabs when /api/tts is unauthorized", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(TTS_MPEG, { status: 200, headers: { "content-type": "audio/mpeg" } });
    });
    const host = ttsHost({ GATEWAY_TOKEN: "gate" });
    const denied = await host.receive({
      method: "POST",
      path: "/api/tts",
      headers: { authorization: "Bearer other" },
      body: JSON.stringify({ text: "早晨" }),
    });
    expect(denied.kind).toBe("respond");
    if (denied.kind !== "respond") return;
    expect(denied.response.status).toBe(401);
    expect(denied.response.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(readReply(denied)).toEqual({ ok: false, error: "unauthorized" });
    expect(calls).toEqual([]);
  });

  it("returns 503 tts-unconfigured and does not fetch when the key is missing", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async () => {
      calls.push("fetched");
      throw new Error("fetched");
    });
    const host = ttsHost({ ALLOW_ANY_TOKEN: "true" });
    const missing = await host.receive({
      method: "POST",
      path: "/api/tts",
      headers: {},
      body: "not-json",
    });
    expect(missing.kind).toBe("respond");
    if (missing.kind !== "respond") return;
    expect(missing.response.status).toBe(503);
    expect(missing.response.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(readReply(missing)).toEqual({ ok: false, error: "tts-unconfigured" });
    expect(calls).toEqual([]);
  });

  it("rejects a tts body that is not speakable text", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async () => {
      calls.push("fetched");
      throw new Error("fetched");
    });
    const host = ttsHost({ ALLOW_ANY_TOKEN: "true", ELEVENLABS_API_KEY: "xi-key" });
    const bodies = [
      null,
      "",
      "{",
      "[]",
      JSON.stringify({}),
      JSON.stringify({ text: 1 }),
      JSON.stringify({ text: "" }),
      JSON.stringify({ text: "   " }),
      JSON.stringify({ text: "a".repeat(5001) }),
    ];
    for (const body of bodies) {
      const served = await host.receive({ method: "POST", path: "/api/tts", headers: {}, body });
      expect(served.kind).toBe("respond");
      if (served.kind !== "respond") return;
      expect(served.response.status).toBe(400);
      expect(readReply(served)).toEqual({ ok: false, error: "bad-request" });
    }
    expect(calls).toEqual([]);
  });

  it("returns the ElevenLabs mpeg bytes for yue eleven_v4_turbo and hides the api key", async () => {
    const calls: { url: string; key: string | null; accept: string | null; type: string | null; authorization: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        key: headers.get("xi-api-key"),
        accept: headers.get("accept"),
        type: headers.get("content-type"),
        authorization: headers.get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(TTS_MPEG, {
        status: 200,
        headers: { "content-type": "audio/mpeg; charset=binary", "xi-api-key": "xi-key" },
      });
    });
    const host = ttsHost({ ALLOW_ANY_TOKEN: "true", ELEVENLABS_API_KEY: "xi-key" });
    const served = await host.receive({
      method: "POST",
      path: "/api/tts",
      headers: { authorization: "Bearer paired" },
      body: JSON.stringify({ text: "see >>> this", voice: "other", model_id: "eleven_turbo", language_code: "en" }),
    });
    expect(served.kind).toBe("respond");
    if (served.kind !== "respond") return;
    expect(calls).toEqual([
      {
        url: `https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_VOICE}?output_format=mp3_44100_128`,
        key: "xi-key",
        accept: "audio/mpeg",
        type: "application/json",
        authorization: null,
        body: { text: "see >>> this", model_id: "eleven_v4_turbo", language_code: "yue" },
      },
    ]);
    expect(served.response.status).toBe(200);
    expect(served.response.headers["content-type"]).toBe("audio/mpeg");
    expect(served.response.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(served.response.headers["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
    expect(served.response.body).toEqual(TTS_MPEG);
    expect(responseDump(served.response)).not.toContain("xi-key");
    const long = await host.receive(ttsRequest("a".repeat(5000)));
    expect(long.kind).toBe("respond");
    if (long.kind !== "respond") return;
    expect(long.response.status).toBe(200);
    expect(long.response.body).toEqual(TTS_MPEG);
    expect(calls[1]?.body).toEqual({ text: "a".repeat(5000), model_id: "eleven_v4_turbo", language_code: "yue" });
  });

  it("uses ELEVENLABS_TTS_VOICE_ID when set and the default voice when blank", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(TTS_MPEG, { status: 200, headers: { "content-type": "audio/mpeg" } });
    });
    const custom = ttsHost({
      ALLOW_ANY_TOKEN: "true",
      ELEVENLABS_API_KEY: "xi-key",
      ELEVENLABS_TTS_VOICE_ID: "  voice-9  ",
    });
    const voiced = await custom.receive(ttsRequest("早晨"));
    expect(voiced.kind).toBe("respond");
    if (voiced.kind !== "respond") return;
    expect(voiced.response.body).toEqual(TTS_MPEG);
    expect(urls).toEqual(["https://api.elevenlabs.io/v1/text-to-speech/voice-9?output_format=mp3_44100_128"]);
    const blank = ttsHost({
      ALLOW_ANY_TOKEN: "true",
      ELEVENLABS_API_KEY: "xi-key",
      ELEVENLABS_TTS_VOICE_ID: "   ",
    });
    const fallback = await blank.receive(ttsRequest("早晨"));
    expect(fallback.kind === "respond" && fallback.response.body).toEqual(TTS_MPEG);
    expect(urls[1]).toBe(`https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_VOICE}?output_format=mp3_44100_128`);
  });

  it("returns 502 when ElevenLabs does not return mpeg bytes", async () => {
    const host = ttsHost({ ALLOW_ANY_TOKEN: "true", ELEVENLABS_API_KEY: "xi-key" });
    const upstream: Array<() => Response | Promise<Response>> = [
      () => new Response("xi-key leaked", { status: 500, headers: { "content-type": "audio/mpeg" } }),
      () => new Response(TTS_MPEG, { status: 200, headers: { "content-type": "application/json" } }),
      () => new Response(new Uint8Array(), { status: 200, headers: { "content-type": "audio/mpeg" } }),
      () => Promise.reject(new Error("xi-key down")),
    ];
    for (const next of upstream) {
      vi.stubGlobal("fetch", next);
      const served = await host.receive(ttsRequest("早晨"));
      expect(served.kind).toBe("respond");
      if (served.kind !== "respond") return;
      expect(served.response.status).toBe(502);
      expect(readReply(served)).toEqual({ ok: false, error: "tts-upstream-failed" });
      expect(responseDump(served.response)).not.toContain("xi-key");
    }
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
