import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";

const COMPLETIONS = "https://even-g2-bridge.saviormike.workers.dev/v1/chat/completions";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("worker binding", () => {
  it("uses each request's binding and leaves the cached host in place", async () => {
    const assets = { fetch: async () => new Response("missing", { status: 404 }) };
    const denied = await worker.fetch(new Request("https://r1.example/api/chat", { method: "POST", body: "{}" }), {
      ASSETS: assets,
    });
    expect(denied.status).toBe(500);
    expect(await denied.text()).toBe("missing-gateway-token");

    const bindingCalls: { url: string; authorization: string | null }[] = [];
    const globalCalls: { url: string; authorization: string | null; key: string | null }[] = [];
    const env = {
      ALLOW_ANY_TOKEN: "true",
      EVEN_G2_TOKEN: "bridge-secret",
      ELEVENLABS_API_KEY: "xi-test",
      EVEN_G2_BRIDGE: {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          bindingCalls.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return new Response(JSON.stringify({ model: "grok-2", choices: [{ message: { content: "Bound." } }] }), {
            status: 200,
          });
        },
      },
      ASSETS: assets,
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      globalCalls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        key: new Headers(init?.headers).get("xi-api-key"),
      });
      throw new Error("global fetch");
    });
    const chat = await worker.fetch(
      new Request("https://r1.example/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello", personaId: "friday" }),
      }),
      env,
    );
    expect(chat.status).toBe(200);
    expect(await chat.json()).toMatchObject({ reply: "Bound.", routedToGrokBot: true });
    expect(bindingCalls).toEqual([{ url: COMPLETIONS, authorization: "Bearer bridge-secret" }]);
    expect(globalCalls).toEqual([]);

    const blocked = await worker.fetch(new Request("https://r1.example/health"), { ASSETS: assets });
    expect(blocked.status).toBe(500);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      globalCalls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        key: new Headers(init?.headers).get("xi-api-key"),
      });
      if (url.includes("elevenlabs")) return new Response(JSON.stringify({ token: "scribe-1" }), { status: 200 });
      return new Response(JSON.stringify({ model: "grok-2", choices: [{ message: { content: "Global." } }] }), {
        status: 200,
      });
    });
    const cleared = await worker.fetch(
      new Request("https://r1.example/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello", personaId: "friday" }),
      }),
      { ...env, EVEN_G2_TOKEN: "other-secret", EVEN_G2_BRIDGE: undefined },
    );
    expect(await cleared.json()).toMatchObject({ reply: "Global." });
    expect(bindingCalls).toHaveLength(1);
    expect(globalCalls.at(-1)).toEqual({ url: COMPLETIONS, authorization: "Bearer bridge-secret", key: null });

    const minted = await worker.fetch(new Request("https://r1.example/api/stt/token", { method: "POST" }), env);
    expect(minted.status).toBe(200);
    expect(await minted.json()).toEqual({ ok: true, token: "scribe-1" });
    expect(globalCalls.at(-1)).toEqual({
      url: "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
      authorization: null,
      key: "xi-test",
    });
    expect(bindingCalls).toHaveLength(1);
  });
});
