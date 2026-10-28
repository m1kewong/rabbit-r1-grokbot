import { afterEach, describe, expect, it, vi } from "vitest";
import { createScribeListen } from "../src/scribe";

type FetchCall = {
  url: string;
  init?: RequestInit;
  resolve: (response: Response) => void;
};

type FakeProcessor = {
  size: number;
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null;
  emit(samples: number[], sampleRate: number): void;
};

class FakeSocket {
  static instances: FakeSocket[] = [];
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }

  close(): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.onclose?.();
  }

  fail(): void {
    this.onerror?.();
  }

  message(body: unknown): void {
    this.onmessage?.({ data: JSON.stringify(body) } as MessageEvent);
  }
}

class FakeContext {
  static made = 0;
  static processors: FakeProcessor[] = [];
  static resumes = 0;
  static gains: number[] = [];
  state = "suspended";
  sampleRate = 16000;
  destination = {};

  constructor(options?: AudioContextOptions) {
    FakeContext.made += 1;
    if (options?.sampleRate) this.sampleRate = options.sampleRate;
  }

  resume(): Promise<void> {
    FakeContext.resumes += 1;
    this.state = "running";
    return Promise.resolve();
  }

  createMediaStreamSource(): { connect(node: unknown): void } {
    return { connect() {} };
  }

  createScriptProcessor(size: number): FakeProcessor & { connect(node: unknown): void; disconnect(): void } {
    const processor: FakeProcessor & { connect(node: unknown): void; disconnect(): void } = {
      size,
      onaudioprocess: null,
      connect() {},
      disconnect() {},
      emit(samples, sampleRate) {
        this.onaudioprocess?.({
          inputBuffer: {
            sampleRate,
            getChannelData: () => Float32Array.from(samples),
          },
        } as unknown as AudioProcessingEvent);
      },
    };
    FakeContext.processors.push(processor);
    return processor;
  }

  createGain(): { gain: { value: number }; connect(node: unknown): void; disconnect(): void } {
    let current = 1;
    return {
      gain: {
        get value() {
          return current;
        },
        set value(next: number) {
          current = next;
          FakeContext.gains.push(next);
        },
      },
      connect() {},
      disconnect() {},
    };
  }
}

type Page = {
  target: Window;
  dispatch(type: string): void;
  listeners: number;
  micCalls: MediaStreamConstraints[];
  stops: number;
  failMic: boolean;
};

function page(options: { audio?: boolean; mic?: boolean } = {}): Page {
  const audio = options.audio !== false;
  const mic = options.mic !== false;
  const listeners = new Map<string, Set<() => void>>();
  const state: Page = {
    target: {} as Window,
    dispatch(type: string) {
      for (const handler of listeners.get(type) ?? []) handler();
    },
    listeners: 0,
    micCalls: [],
    stops: 0,
    failMic: false,
  };
  const target = {
    addEventListener(type: string, handler: () => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
      state.listeners += 1;
    },
    navigator: mic
      ? {
          mediaDevices: {
            getUserMedia: async (constraints: MediaStreamConstraints) => {
              state.micCalls.push(constraints);
              if (state.failMic) throw new Error("denied");
              return { getTracks: () => [{ stop: () => { state.stops += 1; } }] };
            },
          },
        }
      : {},
    AudioContext: audio ? FakeContext : undefined,
    WebSocket: FakeSocket,
  };
  state.target = target as unknown as Window;
  return state;
}

const fetches: FetchCall[] = [];

function installFetch(): void {
  fetches.length = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve) => {
      fetches.push({ url: String(url), init, resolve });
    });
  });
}

function tokenResponse(token: string): Response {
  return new Response(JSON.stringify({ ok: true, token }), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeSocket.instances = [];
  FakeContext.made = 0;
  FakeContext.processors = [];
  FakeContext.resumes = 0;
  FakeContext.gains = [];
});

describe("createScribeListen", () => {
  it("returns null when the mic or the audio context is missing", () => {
    const noMic = page({ mic: false });
    const missingMic = createScribeListen({ target: noMic.target, now: () => 0, chatBearer: async () => null });
    expect(missingMic({ onPartial() {} })).toBeNull();
    const noAudio = page({ audio: false });
    const missingAudio = createScribeListen({ target: noAudio.target, now: () => 0, chatBearer: async () => null });
    expect(missingAudio({ onPartial() {} })).toBeNull();
  });

  it("warms one ticket on pointer, touch, and click, then spends it once", async () => {
    installFetch();
    let now = 0;
    const view = page();
    const listen = createScribeListen({
      target: view.target,
      now: () => now,
      chatBearer: async () => "chat-secret",
    });
    const again = createScribeListen({
      target: view.target,
      now: () => now,
      chatBearer: async () => "chat-secret",
    });
    expect(view.listeners).toBe(3);
    void again;
    view.dispatch("pointerdown");
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    expect(fetches[0]?.url).toBe("/api/stt/token");
    expect(new Headers(fetches[0]?.init?.headers).get("authorization")).toBe("Bearer chat-secret");
    expect(new Headers(fetches[0]?.init?.headers).get("xi-api-key")).toBeNull();
    view.dispatch("touchstart");
    view.dispatch("click");
    expect(fetches).toHaveLength(1);
    expect(FakeContext.made).toBe(1);
    expect(FakeContext.resumes).toBe(3);
    fetches[0]?.resolve(tokenResponse("ticket-a"));
    await Promise.resolve();
    const first = listen({ onPartial() {} });
    expect(first).toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(new URL(FakeSocket.instances[0]?.url ?? "").searchParams.get("token")).toBe("ticket-a");
    await vi.waitFor(() => expect(fetches).toHaveLength(2));
    const second = listen({ onPartial() {} });
    fetches[1]?.resolve(tokenResponse("ticket-b"));
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    expect(new URL(FakeSocket.instances[1]?.url ?? "").searchParams.get("token")).toBe("ticket-b");
    FakeSocket.instances[0]?.open();
    FakeSocket.instances[1]?.open();
    expect(await first).not.toBeNull();
    expect(await second).not.toBeNull();

    now = 10 * 60 * 1000;
    const expired = listen({ onPartial() {} });
    await vi.waitFor(() => expect(fetches).toHaveLength(3));
    fetches[2]?.resolve(tokenResponse("ticket-c"));
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(3));
    expect(new URL(FakeSocket.instances[2]?.url ?? "").searchParams.get("token")).toBe("ticket-c");
    FakeSocket.instances[2]?.open();
    expect(await expired).not.toBeNull();
  });

  it("streams pcm, commits with an empty chunk, and keeps the timestamps event out of the utterance", async () => {
    installFetch();
    const view = page();
    const listen = createScribeListen({
      target: view.target,
      now: () => 0,
      chatBearer: async () => null,
    });
    const partials: string[] = [];
    const pending = listen({ onPartial(text) { partials.push(text); } });
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    fetches[0]?.resolve(tokenResponse("ticket"));
    await vi.waitFor(() => expect(FakeContext.processors).toHaveLength(1));
    const socket = FakeSocket.instances[0];
    const processor = FakeContext.processors[0];
    expect(socket).toBeDefined();
    expect(processor).toBeDefined();
    if (!socket || !processor) return;
    expect(processor.size).toBe(4096);
    expect(FakeContext.gains).toEqual([0]);
    expect(view.micCalls).toEqual([
      {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 16000,
        },
      },
    ]);
    const url = new URL(socket.url);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(url.searchParams.get("audio_format")).toBe("pcm_16000");
    expect(url.searchParams.get("commit_strategy")).toBe("manual");
    expect(url.searchParams.get("language_code")).toBe("yue");
    expect(url.searchParams.getAll("secondary_languages")).toEqual(["en", "zh"]);
    expect(url.searchParams.get("include_language_detection")).toBe("true");
    processor.emit([0, 1], 16000);
    processor.emit([1, 1, -1, -1], 32000);
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      {
        message_type: "input_audio_chunk",
        audio_base_64: btoa(String.fromCharCode(0, 0, 0xff, 0x7f)),
        commit: false,
        sample_rate: 16000,
      },
      {
        message_type: "input_audio_chunk",
        audio_base_64: btoa(String.fromCharCode(0xff, 0x7f, 0x00, 0x80)),
        commit: false,
        sample_rate: 16000,
      },
    ]);
    const session = await pending;
    expect(session).not.toBeNull();
    if (!session) return;
    socket.message({ message_type: "partial_transcript", text: "早" });
    expect(partials).toEqual(["早"]);
    socket.message({ message_type: "committed_transcript", text: "早" });
    socket.message({ message_type: "committed_transcript_with_timestamps", text: "IGNORE" });
    const stopped = session.stop();
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toEqual({
      message_type: "input_audio_chunk",
      audio_base_64: "",
      commit: true,
      sample_rate: 16000,
    });
    socket.message({ message_type: "committed_transcript", text: "晨" });
    await expect(stopped).resolves.toBe("早晨");
    expect(view.stops).toBe(1);
  });

  it("uses the partial when the socket closes without a commit, and stops the mic when open fails", async () => {
    installFetch();
    const view = page();
    const listen = createScribeListen({
      target: view.target,
      now: () => 0,
      chatBearer: async () => null,
    });
    const pending = listen({ onPartial() {} });
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    fetches[0]?.resolve(tokenResponse("ticket"));
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0];
    if (!socket) return;
    socket.open();
    const session = await pending;
    if (!session) throw new Error("expected a session");
    socket.message({ message_type: "partial_transcript", text: "  早晨  " });
    const stopped = session.stop();
    socket.close();
    await expect(stopped).resolves.toBe("早晨");

    FakeSocket.instances = [];
    const denied = page();
    denied.failMic = true;
    installFetch();
    const failedMic = createScribeListen({
      target: denied.target,
      now: () => 0,
      chatBearer: async () => null,
    });
    const micPending = failedMic({ onPartial() {} });
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    fetches[0]?.resolve(tokenResponse("ticket"));
    await expect(micPending).resolves.toBeNull();
    expect(FakeSocket.instances).toHaveLength(0);

    FakeSocket.instances = [];
    const broken = page();
    installFetch();
    const failedSocket = createScribeListen({
      target: broken.target,
      now: () => 0,
      chatBearer: async () => null,
    });
    const socketPending = failedSocket({ onPartial() {} });
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    fetches[0]?.resolve(tokenResponse("ticket"));
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    FakeSocket.instances[0]?.fail();
    await expect(socketPending).resolves.toBeNull();
    expect(broken.stops).toBe(1);

    FakeSocket.instances = [];
    const unconfigured = page();
    installFetch();
    const noToken = createScribeListen({
      target: unconfigured.target,
      now: () => 0,
      chatBearer: async () => null,
    });
    const tokenPending = noToken({ onPartial() {} });
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    fetches[0]?.resolve(new Response(JSON.stringify({ ok: false }), { status: 503 }));
    await expect(tokenPending).resolves.toBeNull();
    expect(unconfigured.micCalls).toEqual([]);
  });
});
