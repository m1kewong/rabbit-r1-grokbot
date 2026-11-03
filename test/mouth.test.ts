// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { startDrive } from "../src/drive";
import { createMouth } from "../src/mouth";
import { paint } from "../src/ui";
import { audibleReply, TTS_PATH } from "../src/yue";

const REPLY = "see >>> this";
const READ_ALOUD = {
  message:
    "Read the following text aloud exactly, word for word. Do not add, omit, translate, or summarize anything.\n\n<<<\nsee >>> this\n>>>",
  useLLM: true,
  wantsR1Response: true,
  wantsJournalEntry: false,
};

class FakeAudio {
  static plays = 0;
  static fail = false;
  constructor(readonly src: string) {}
  pause(): void {}
  play(): Promise<void> {
    FakeAudio.plays += 1;
    if (FakeAudio.fail) return Promise.reject(new Error("play"));
    return Promise.resolve();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function installAudio(): void {
  FakeAudio.plays = 0;
  FakeAudio.fail = false;
  vi.stubGlobal("Audio", FakeAudio);
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:yue",
    });
  }
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: () => {},
    });
  }
}

async function spokenLog(options: {
  speaker: boolean;
  bearer: string | null;
  failPlay?: boolean;
  tts: () => Response | Promise<Response>;
}): Promise<{ log: HTMLElement; posts: string[]; calls: RequestInit[] }> {
  installAudio();
  FakeAudio.fail = options.failPlay === true;
  const posts: string[] = [];
  const calls: RequestInit[] = [];
  let poster: { postMessage(message: string): void } | null = null;
  const mouth = createMouth({
    chatBearer: async () => options.bearer,
    plugin: () => poster,
  });
  poster = {
    postMessage(message: string) {
      posts.push(message);
    },
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === TTS_PATH) {
      calls.push(init ?? {});
      return options.tts();
    }
    return new Response(
      JSON.stringify({
        ok: true,
        reply: REPLY,
        model: "local-friday",
        personaId: "friday",
        routedToGrokBot: false,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  window.history.replaceState(null, "", "/?r1=1");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 240 });
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const timers: Array<{ fire: () => void }> = [];
  const drive = startDrive({
    now: () => 0,
    loadToken: () => Promise.resolve(null),
    capture: () => Promise.resolve(null),
    mouth,
    exit() {},
    schedule(_delayMs, fire) {
      timers.push({ fire });
      return () => {};
    },
    render(state, dispatch) {
      paint(root, window, state, dispatch);
    },
    viewport: window,
  });
  if (options.speaker) drive.control("toggleSpeaker");
  drive.control("sideClick");
  timers.at(-1)?.fire();
  const log = root.querySelector("[data-bind=log]");
  if (!(log instanceof HTMLElement)) throw new Error("log");
  await vi.waitFor(() => expect(log.textContent).toContain(REPLY));
  return { log, posts, calls };
}

describe("cantonese mouth", () => {
  it("does not fetch /api/tts while the speaker is off", async () => {
    const { log, calls, posts } = await spokenLog({
      speaker: false,
      bearer: "paired-token",
      tts: () => new Response(Uint8Array.from([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
    expect(posts).toEqual([]);
    expect(FakeAudio.plays).toBe(0);
    expect(log.textContent).toContain(REPLY);
    expect(log.textContent).not.toContain("NO TTS KEY");
    expect(log.textContent).not.toContain("TTS FAIL");
  });

  it("posts the verbatim reply to /api/tts with the paired bearer and plays the mpeg", async () => {
    const mpeg = Uint8Array.from([1, 2, 3, 4]);
    const { log, calls, posts } = await spokenLog({
      speaker: true,
      bearer: "paired-token",
      tts: () => new Response(mpeg, { status: 200, headers: { "content-type": "audio/mpeg" } }),
    });
    await vi.waitFor(() => expect(FakeAudio.plays).toBe(1));
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0]?.headers);
    expect(headers.get("authorization")).toBe("Bearer paired-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("xi-api-key")).toBeNull();
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ text: REPLY });
    expect(posts).toEqual([]);
    expect(log.textContent).toContain(REPLY);
    expect(log.innerHTML).not.toContain("TTS FAIL");
    expect(log.innerHTML).not.toContain("NO TTS KEY");
  });

  it("omits Authorization when the handset has no paired token", async () => {
    const { calls } = await spokenLog({
      speaker: true,
      bearer: null,
      tts: () => new Response(Uint8Array.from([1]), { status: 200, headers: { "content-type": "audio/mpeg" } }),
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(new Headers(calls[0]?.headers).get("authorization")).toBeNull();
    expect(JSON.parse(String(calls[0]?.body))).toEqual({ text: REPLY });
  });

  it("shows NO TTS KEY and posts the read-aloud payload when /api/tts returns 503", async () => {
    const { log, posts } = await spokenLog({
      speaker: true,
      bearer: "paired-token",
      tts: () => new Response(JSON.stringify({ ok: false, error: "tts-unconfigured" }), { status: 503 }),
    });
    await vi.waitFor(() => {
      expect(log.innerHTML).toContain('<p class="line failed"><span>Spk</span>NO TTS KEY</p>');
    });
    expect(log.textContent).toContain(REPLY);
    expect(posts.map((message) => JSON.parse(message))).toEqual([READ_ALOUD]);
    expect(FakeAudio.plays).toBe(0);
  });

  it("shows TTS FAIL and skips the plugin when mpeg playback rejects", async () => {
    const { log, posts } = await spokenLog({
      speaker: true,
      bearer: "paired-token",
      failPlay: true,
      tts: () => new Response(Uint8Array.from([9, 8, 7]), { status: 200, headers: { "content-type": "audio/mpeg" } }),
    });
    await vi.waitFor(() => {
      expect(log.innerHTML).toContain('<p class="line failed"><span>Spk</span>TTS FAIL</p>');
    });
    expect(log.textContent).toContain(REPLY);
    expect(posts).toEqual([]);
    expect(FakeAudio.plays).toBe(1);
  });

  it("shows TTS FAIL and posts the read-aloud payload when /api/tts returns 502", async () => {
    const { log, posts } = await spokenLog({
      speaker: true,
      bearer: null,
      tts: () => new Response("nope", { status: 502, headers: { "content-type": "application/json" } }),
    });
    await vi.waitFor(() => {
      expect(log.innerHTML).toContain('<p class="line failed"><span>Spk</span>TTS FAIL</p>');
    });
    expect(log.textContent).toContain(REPLY);
    expect(log.innerHTML).not.toContain("NO TTS KEY");
    expect(posts.map((message) => JSON.parse(message))).toEqual([READ_ALOUD]);
  });

  it("drops an in-flight speak when hush runs and does not post the plugin", async () => {
    const posts: string[] = [];
    let release: (response: Response) => void = () => {};
    const hung = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let fetched = false;
    vi.stubGlobal("fetch", () => {
      fetched = true;
      return hung;
    });
    const mouth = createMouth({
      chatBearer: async () => "paired-token",
      plugin: () => ({
        postMessage(message: string) {
          posts.push(message);
        },
      }),
    });
    const text = audibleReply("早晨");
    if (text === null) throw new Error("audible");
    const pending = mouth.speak(text);
    await vi.waitFor(() => expect(fetched).toBe(true));
    mouth.hush();
    release(new Response("no", { status: 503 }));
    await expect(pending).resolves.toEqual({ tag: "dropped" });
    expect(posts).toEqual([]);
  });

  it("drops playback that hush interrupts and does not post the plugin", async () => {
    installAudio();
    let release: (failed: boolean) => void = () => {};
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    class HoldingAudio extends FakeAudio {
      override play(): Promise<void> {
        FakeAudio.plays += 1;
        return gate.then((failed) => {
          if (failed) throw new Error("play");
        });
      }
    }
    vi.stubGlobal("Audio", HoldingAudio);
    const posts: string[] = [];
    vi.stubGlobal("fetch", async () => {
      return new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    });
    const mouth = createMouth({
      chatBearer: async () => null,
      plugin: () => ({
        postMessage(message: string) {
          posts.push(message);
        },
      }),
    });
    const text = audibleReply("早晨");
    if (text === null) throw new Error("audible");
    const pending = mouth.speak(text);
    await vi.waitFor(() => expect(FakeAudio.plays).toBe(1));
    mouth.hush();
    release(true);
    await expect(pending).resolves.toEqual({ tag: "dropped" });
    expect(posts).toEqual([]);
  });
});
