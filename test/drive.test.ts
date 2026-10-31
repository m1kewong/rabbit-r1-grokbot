import { afterEach, describe, expect, it, vi } from "vitest";
import { startDrive, type StreamCallbacks } from "../src/drive";
import { buildSpeakPayload, type DeviceState, type SpeakPayload } from "../src/device";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startDrive", () => {
  it("waits 250ms, cycles presets instead of sending, then speaks a reply in send order", async () => {
    const timers: { delayMs: number; fire: () => void; cancelled: boolean }[] = [];
    const calls: { message: string }[] = [];
    const spoken: SpeakPayload[] = [];
    const screens: DeviceState[] = [];
    let now = 5_000;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as { message: string });
      return new Response(
        JSON.stringify({
          ok: true,
          reply: calls.length === 1 ? "First" : "Second",
          model: "local-friday",
          personaId: "friday",
          routedToGrokBot: false,
        }),
      );
    });
    const drive = startDrive({
      now: () => now,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.resolve("lights"),
      speak(payload) {
        spoken.push(payload);
      },
      exit() {},
      schedule(delayMs, fire) {
        const timer = { delayMs, fire, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      render(state) {
        screens.push(state);
      },
    });
    drive.control("sideClick");
    drive.control("sideClick");
    expect(timers[0]?.delayMs).toBe(250);
    expect(timers[0]?.cancelled).toBe(true);
    expect(screens.at(-1)?.presetId).toBe("brief");
    timers[0]?.fire();
    await Promise.resolve();
    expect(calls).toEqual([]);

    drive.control("toggleSpeaker");
    now = 8_000;
    drive.control("sideClick");
    timers.at(-1)?.fire();
    await vi.waitFor(() =>
      expect(calls.map((call) => call.message)).toEqual(["Brief me on what matters today."]),
    );
    await vi.waitFor(() =>
      expect(spoken).toEqual([buildSpeakPayload("First")]),
    );

    drive.control("longPressStart");
    drive.control("longPressEnd");
    await vi.waitFor(() => expect(calls.map((call) => call.message)).toContain("lights"));
    await vi.waitFor(() =>
      expect(spoken).toEqual([buildSpeakPayload("First"), buildSpeakPayload("Second")]),
    );
    drive.wheel(12);
    expect(screens.at(-1)?.personaId).toBe("jarvis");
    drive.wheel(-3);
    expect(screens.at(-1)?.personaId).toBe("friday");
    drive.control("exit");
  });

  it("does not post a hold that returns no speech", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { message: string };
      calls.push(body.message);
      return new Response(
        JSON.stringify({
          ok: true,
          reply: "no",
          model: "local-friday",
          personaId: "friday",
          routedToGrokBot: false,
        }),
      );
    });
    const drive = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.resolve(null),
      speak() {},
      exit() {},
      schedule: () => () => {},
      render() {},
    });
    drive.control("longPressStart");
    drive.control("longPressEnd");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  it("starts native speech on hold and posts only an sttEnded transcript", async () => {
    const calls: string[] = [];
    const posts: string[] = [];
    let onPluginMessage: ((data: unknown) => void) | undefined;
    const pluginTarget = {
      CreationVoiceHandler: {
        postMessage(message: string) {
          posts.push(message);
        },
      },
      get onPluginMessage() {
        return onPluginMessage;
      },
      set onPluginMessage(handler: ((data: unknown) => void) | undefined) {
        onPluginMessage = handler;
      },
    };
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { message: string };
      calls.push(body.message);
      return new Response(
        JSON.stringify({
          ok: true,
          reply: "Bay open",
          model: "grok-4",
          personaId: "friday",
          routedToGrokBot: true,
        }),
      );
    });
    const drive = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.reject(new Error("web speech should stay unused")),
      speak() {},
      exit() {},
      schedule: () => () => {},
      render() {},
      pluginTarget: pluginTarget as { onPluginMessage?: (data: unknown) => void },
    });
    onPluginMessage?.({ type: "sttEnded", transcript: "too early" });
    expect(calls).toEqual([]);
    drive.control("longPressStart");
    expect(posts).toEqual(["start"]);
    onPluginMessage?.({ type: "llm", message: "Give me a status report." });
    onPluginMessage?.({ transcript: "sneaky" });
    drive.control("longPressEnd");
    expect(posts).toEqual(["start", "stop"]);
    await Promise.resolve();
    expect(calls).toEqual([]);
    onPluginMessage?.({ type: "sttEnded", transcript: "   " });
    await Promise.resolve();
    expect(calls).toEqual([]);
    drive.control("longPressStart");
    drive.control("longPressEnd");
    onPluginMessage?.(JSON.stringify({ type: "sttEnded", transcript: "open the bay" }));
    await vi.waitFor(() => expect(calls).toEqual(["open the bay"]));
  });

  it("posts Cantonese that arrives before stop, and after stop", async () => {
    const calls: string[] = [];
    const posts: string[] = [];
    let onPluginMessage: ((data: unknown) => void) | undefined;
    const pluginTarget = {
      CreationVoiceHandler: { postMessage(message: string) { posts.push(message); } },
      get onPluginMessage() { return onPluginMessage; },
      set onPluginMessage(handler: ((data: unknown) => void) | undefined) { onPluginMessage = handler; },
    };
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push((JSON.parse(String(init?.body)) as { message: string }).message);
      return new Response(JSON.stringify({ ok: true, reply: "好", model: "grok", personaId: "friday", routedToGrokBot: true }));
    });
    const screens: { turn: { tag: string; ear?: string }; gesture: { tag: string } }[] = [];
    const timers: { fire: () => void }[] = [];
    const drive = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.reject(new Error("web speech unused")),
      speak() {},
      exit() {},
      schedule(_delay, fire) {
        const timer = { fire };
        timers.push(timer);
        return () => { timer.fire = () => {}; };
      },
      render(state) { screens.push(state); },
      pluginTarget: pluginTarget as { onPluginMessage?: (data: unknown) => void },
    });
    drive.control("longPressStart");
    expect(screens.at(-1)?.gesture.tag).toBe("ptt-armed");
    onPluginMessage?.({ type: "sttEnded", transcript: "早晨" });
    expect(calls).toEqual([]);
    drive.control("longPressEnd");
    await vi.waitFor(() => expect(calls).toEqual(["早晨"]));
    await vi.waitFor(() => expect(screens.at(-1)?.turn.tag).toBe("done"));
    expect(posts).toEqual(["start", "stop"]);

    drive.control("longPressStart");
    drive.control("longPressEnd");
    expect(calls).toEqual(["早晨"]);
    onPluginMessage?.({ type: "sttEnded", transcript: "唔該" });
    await vi.waitFor(() => expect(calls).toEqual(["早晨", "唔該"]));
    timers.at(-1)?.fire();
    expect(calls).toEqual(["早晨", "唔該"]);
  });

  it("shows no speech after the handset stays quiet, and no mic when the bridge is missing", async () => {
    const calls: string[] = [];
    let captured = false;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push((JSON.parse(String(init?.body)) as { message: string }).message);
      return new Response(JSON.stringify({ ok: true, reply: "no", model: "local-friday", personaId: "friday", routedToGrokBot: false }));
    });
    const screens: { turn: { tag: string; ear?: string }; gesture: { tag: string } }[] = [];
    const timers: { fire: () => void }[] = [];
    let onPluginMessage: ((data: unknown) => void) | undefined;
    const native = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.reject(new Error("unused")),
      speak() {},
      exit() {},
      schedule(_delay, fire) {
        timers.push({ fire });
        return () => {};
      },
      render(state) { screens.push(state); },
      pluginTarget: {
        CreationVoiceHandler: { postMessage() {} },
        get onPluginMessage() { return onPluginMessage; },
        set onPluginMessage(handler: ((data: unknown) => void) | undefined) { onPluginMessage = handler; },
      },
    });
    native.control("longPressStart");
    native.control("longPressEnd");
    expect(screens.at(-1)?.gesture.tag).toBe("awaiting-utterance");
    timers.at(-1)?.fire();
    expect(calls).toEqual([]);
    expect(screens.at(-1)?.turn).toEqual({ tag: "silent", ear: "r1" });

    const quiet = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture() {
        captured = true;
        return Promise.resolve(null);
      },
      speak() {},
      exit() {},
      schedule: () => () => {},
      render(state) { screens.push(state); },
      hasMic: () => false,
    });
    quiet.control("longPressStart");
    expect(screens.at(-1)?.gesture.tag).toBe("ptt-armed");
    quiet.control("longPressEnd");
    expect(captured).toBe(false);
    expect(calls).toEqual([]);
    expect(screens.at(-1)?.turn.tag).toBe("no-mic");
  });

  it("posts one stream utterance and keeps partials off the chat", async () => {
    const calls: string[] = [];
    const posts: string[] = [];
    const screens: DeviceState[] = [];
    let emit: (text: string) => void = () => {};
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push((JSON.parse(String(init?.body)) as { message: string }).message);
      return new Response(JSON.stringify({ ok: true, reply: "ok", model: "grok", personaId: "friday", routedToGrokBot: true }));
    });
    const drive = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.reject(new Error("web speech unused")),
      speak() {},
      exit() {},
      schedule: () => () => {},
      render(state) {
        screens.push(state);
      },
      pluginTarget: {
        CreationVoiceHandler: { postMessage(message: string) { posts.push(message); } },
      },
      streamListen(callbacks) {
        emit = callbacks.onPartial;
        return {
          stop: () => Promise.resolve("bay door"),
          cancel() {},
        };
      },
    });
    drive.control("longPressStart");
    expect(posts).toEqual([]);
    emit("bay");
    expect(screens.at(-1)?.gesture).toEqual({ tag: "ptt-armed", partial: "bay" });
    expect(calls).toEqual([]);
    drive.control("longPressEnd");
    expect(screens.at(-1)?.gesture.tag).toBe("awaiting-utterance");
    await vi.waitFor(() => expect(calls).toEqual(["bay door"]));
    expect(posts).toEqual([]);
  });

  it("falls through to the handset when streaming is missing, null, or rejected", async () => {
    const posts: string[] = [];
    const pluginTarget = {
      CreationVoiceHandler: { postMessage(message: string) { posts.push(message); } },
    };
    const missing = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.reject(new Error("unused")),
      speak() {},
      exit() {},
      schedule: () => () => {},
      render() {},
      pluginTarget,
      streamListen: () => null,
    });
    missing.control("longPressStart");
    expect(posts).toEqual(["start"]);

    const thrown = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.reject(new Error("unused")),
      speak() {},
      exit() {},
      schedule: () => () => {},
      render() {},
      pluginTarget,
      streamListen() {
        throw new Error("no audio");
      },
    });
    thrown.control("longPressStart");
    expect(posts).toEqual(["start", "start"]);

    let rejectOpen: (reason: unknown) => void = () => {};
    let resolveOpen: (handle: { stop(): Promise<string | null>; cancel(): void } | null) => void = () => {};
    const opened = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.reject(new Error("unused")),
      speak() {},
      exit() {},
      schedule: () => () => {},
      render() {},
      pluginTarget,
      streamListen: () => new Promise((resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
      }),
    });
    opened.control("longPressStart");
    expect(posts).toEqual(["start", "start"]);
    rejectOpen(new Error("down"));
    await Promise.resolve();
    await Promise.resolve();
    expect(posts).toEqual(["start", "start", "start"]);

    const quiet = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.reject(new Error("unused")),
      speak() {},
      exit() {},
      schedule: () => () => {},
      render() {},
      pluginTarget,
      streamListen: () => new Promise((resolve) => {
        resolveOpen = resolve;
      }),
    });
    quiet.control("longPressStart");
    expect(posts).toEqual(["start", "start", "start"]);
    resolveOpen(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(posts).toEqual(["start", "start", "start", "start"]);
  });

  it("does not start the handset after release, and a late handle is the one utterance", async () => {
    const calls: string[] = [];
    const posts: string[] = [];
    const screens: DeviceState[] = [];
    let resolveOpen: (handle: { stop(): Promise<string>; cancel(): void } | null) => void = () => {};
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push((JSON.parse(String(init?.body)) as { message: string }).message);
      return new Response(JSON.stringify({ ok: true, reply: "ok", model: "grok", personaId: "friday", routedToGrokBot: true }));
    });
    const drive = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.reject(new Error("unused")),
      speak() {},
      exit() {},
      schedule: () => () => {},
      render(state) {
        screens.push(state);
      },
      pluginTarget: {
        CreationVoiceHandler: { postMessage(message: string) { posts.push(message); } },
      },
      streamListen: () => new Promise((resolve) => {
        resolveOpen = resolve;
      }),
    });
    drive.control("longPressStart");
    drive.control("longPressEnd");
    expect(posts).toEqual([]);
    expect(calls).toEqual([]);
    resolveOpen(null);
    await Promise.resolve();
    await Promise.resolve();
    expect(posts).toEqual([]);
    expect(calls).toEqual([]);
    expect(screens.at(-1)?.turn).toEqual({ tag: "silent" });

    let stopped = false;
    const late = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.reject(new Error("unused")),
      speak() {},
      exit() {},
      schedule: () => () => {},
      render(state) {
        screens.push(state);
      },
      pluginTarget: {
        CreationVoiceHandler: { postMessage(message: string) { posts.push(message); } },
      },
      streamListen: () => new Promise((resolve) => {
        resolveOpen = resolve;
      }),
    });
    late.control("longPressStart");
    late.control("longPressEnd");
    resolveOpen({
      stop: () => {
        stopped = true;
        return Promise.resolve("late");
      },
      cancel() {},
    });
    await vi.waitFor(() => expect(calls).toEqual(["late"]));
    expect(stopped).toBe(true);
    expect(posts).toEqual([]);
  });

  it("cancels a stream that arrives after the next hold and stays silent when stop fails", async () => {
    const calls: string[] = [];
    const posts: string[] = [];
    const screens: DeviceState[] = [];
    const resolvers: ((handle: { stop(): Promise<string>; cancel(): void } | null) => void)[] = [];
    let cancelled = false;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push((JSON.parse(String(init?.body)) as { message: string }).message);
      return new Response(JSON.stringify({ ok: true, reply: "ok", model: "grok", personaId: "friday", routedToGrokBot: true }));
    });
    const drive = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.reject(new Error("unused")),
      speak() {},
      exit() {},
      schedule: () => () => {},
      render(state) {
        screens.push(state);
      },
      pluginTarget: {
        CreationVoiceHandler: { postMessage(message: string) { posts.push(message); } },
      },
      streamListen: () => new Promise((resolve) => {
        resolvers.push(resolve);
      }),
    });
    drive.control("longPressStart");
    drive.control("longPressEnd");
    drive.control("longPressStart");
    resolvers[0]?.({
      stop: () => Promise.resolve("stale"),
      cancel() {
        cancelled = true;
      },
    });
    await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(calls).toEqual([]);
    expect(posts).toEqual([]);

    const failed = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.reject(new Error("unused")),
      speak() {},
      exit() {},
      schedule: () => () => {},
      render(state) {
        screens.push(state);
      },
      pluginTarget: {
        CreationVoiceHandler: { postMessage(message: string) { posts.push(message); } },
      },
      streamListen: () => ({
        stop: () => Promise.reject(new Error("socket")),
        cancel() {},
      }),
    });
    failed.control("longPressStart");
    failed.control("longPressEnd");
    await Promise.resolve();
    await Promise.resolve();
    expect(posts).toEqual([]);
    expect(calls).toEqual([]);
    expect(screens.at(-1)?.turn).toEqual({ tag: "silent" });
  });
});


describe("ear report", () => {
  function rig(options: {
    streamListen: NonNullable<Parameters<typeof startDrive>[0]["streamListen"]>;
    handset?: boolean;
    mic?: boolean;
  }): { drive: ReturnType<typeof startDrive>; screens: DeviceState[] } {
    const screens: DeviceState[] = [];
    const drive = startDrive({
      now: () => 0,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.resolve(null),
      speak() {},
      exit() {},
      schedule: () => () => {},
      render(state) {
        screens.push(state);
      },
      hasMic: () => options.mic !== false,
      pluginTarget: options.handset === false ? undefined : { CreationVoiceHandler: { postMessage() {} } },
      streamListen: options.streamListen,
    });
    return { drive, screens };
  }

  it("names the reason Scribe was skipped when the R1 recognizer takes over", async () => {
    const { drive, screens } = rig({
      streamListen(callbacks) {
        callbacks.onFail?.("AUTH");
        return Promise.resolve(null);
      },
    });
    drive.control("longPressStart");
    await vi.waitFor(() => expect(screens.at(-1)?.ear).toEqual({ engine: "r1", note: "AUTH" }));
  });

  it("reports the browser recognizer and a missing mic with the same reason", async () => {
    const browser = rig({
      handset: false,
      streamListen(callbacks) {
        callbacks.onFail?.("NO-KEY");
        return null;
      },
    });
    browser.drive.control("longPressStart");
    expect(browser.screens.at(-1)?.ear).toEqual({ engine: "browser", note: "NO-KEY" });
    const bare = rig({
      handset: false,
      mic: false,
      streamListen(callbacks) {
        callbacks.onFail?.("NO-API");
        return null;
      },
    });
    bare.drive.control("longPressStart");
    expect(bare.screens.at(-1)?.ear).toEqual({ engine: "none", note: "NO-API" });
  });

  it("marks a live session as Scribe, surfaces a mid-hold fault, and routes the mic level", async () => {
    const held: { callbacks: StreamCallbacks | null } = { callbacks: null };
    const { drive, screens } = rig({
      streamListen(next) {
        held.callbacks = next;
        return Promise.resolve({ stop: () => Promise.resolve("bay"), cancel() {} });
      },
    });
    drive.control("longPressStart");
    held.callbacks?.onLevel?.(0.6);
    expect(screens.at(-1)?.level).toBe(0.625);
    await vi.waitFor(() => expect(screens.at(-1)?.ear).toEqual({ engine: "scribe", note: null }));
    held.callbacks?.onFail?.("SRV-QUOTA_EXCEEDED");
    expect(screens.at(-1)?.ear).toEqual({ engine: "scribe", note: "SRV-QUOTA_EXCEEDED" });
    drive.control("longPressEnd");
    held.callbacks?.onLevel?.(0.9);
    expect(screens.at(-1)?.level).toBe(0);
  });
});
