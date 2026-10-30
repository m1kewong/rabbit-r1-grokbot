import type { StreamCallbacks, StreamListen, StreamSession } from "./drive";

const SCRIBE_HZ = 16000;
const TICKET_TTL_MS = 10 * 60 * 1000;
const COMMIT_WAIT_MS = 1_200;
const TAIL_MS = 300;
const PCM_WINDOW = 2048;
const LEVEL_GAIN = 6;

const MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: SCRIBE_HZ,
} as const;

type AudioChunk = {
  readonly message_type: "input_audio_chunk";
  readonly audio_base_64: string;
  readonly commit: boolean;
  readonly sample_rate: typeof SCRIBE_HZ;
};

type ScribeToken = string & { readonly __brand: "ScribeToken" };

type Mint =
  | { readonly tag: "token"; readonly token: ScribeToken }
  | { readonly tag: "fail"; readonly reason: string };

type TokenShelf =
  | { readonly tag: "idle" }
  | { readonly tag: "pending"; readonly task: Promise<ScribeToken | null> }
  | { readonly tag: "fresh"; readonly token: ScribeToken; readonly atMs: number };

type QueuedChunk = { readonly payload: string; readonly commit: boolean };

type SocketGate =
  | { tag: "connecting"; queued: QueuedChunk[] }
  | { tag: "open" }
  | { tag: "closed" };

type ScribeRun = {
  committedText: string;
  latestPartial: string;
  gate: SocketGate;
  socket: WebSocket;
  stopGate: Promise<string> | null;
  commitSent: boolean;
  sealed: boolean;
  finishStop: (() => void) | null;
};

type ScribeEnv = {
  readonly target: Window;
  now(): number;
  chatBearer(): Promise<string | null>;
  readonly tailMs?: number;
};

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;
type SocketCtor = new (url: string) => WebSocket;

const contexts = new WeakMap<Window, AudioContext>();
const armedWindows = new WeakSet<Window>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ignore(run: () => void): void {
  try {
    run();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
  }
}

function scribeSocketUrl(token: string): string {
  const url = new URL("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
  url.searchParams.set("model_id", "scribe_v2_realtime");
  url.searchParams.set("token", token);
  url.searchParams.set("audio_format", "pcm_16000");
  url.searchParams.set("commit_strategy", "manual");
  url.searchParams.set("language_code", "yue");
  url.searchParams.append("secondary_languages", "en");
  url.searchParams.append("secondary_languages", "zh");
  url.searchParams.set("include_language_detection", "true");
  return url.toString();
}

function floatToI16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function downsample(samples: Float32Array, fromHz: number): Float32Array {
  if (fromHz <= SCRIBE_HZ) return samples;
  const ratio = fromHz / SCRIBE_HZ;
  const length = Math.floor(samples.length / ratio);
  const out = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let cursor = start; cursor < end; cursor += 1) {
      sum += samples[cursor] ?? 0;
      count += 1;
    }
    out[index] = count === 0 ? 0 : sum / count;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index] ?? 0);
  return btoa(binary);
}

function pcm16Base64(samples: Float32Array, fromHz: number): string {
  const mono = fromHz === SCRIBE_HZ ? samples : downsample(samples, fromHz);
  if (mono.length === 0) return "";
  const bytes = new Uint8Array(mono.length * 2);
  for (let index = 0; index < mono.length; index += 1) {
    const value = floatToI16(mono[index] ?? 0);
    bytes[index * 2] = value & 0xff;
    bytes[index * 2 + 1] = (value >> 8) & 0xff;
  }
  return bytesToBase64(bytes);
}

type Shelf = {
  warm(): void;
  take(nowMs: number): Promise<ScribeToken | null>;
  failure(): string;
};

function createShelf(
  mint: (bearer: string | null) => Promise<Mint>,
  now: () => number,
  chatBearer: () => Promise<string | null>,
): Shelf {
  let slot: TokenShelf = { tag: "idle" };
  let failure = "NET";

  function shelfNow(): TokenShelf {
    return slot;
  }

  function begin(): void {
    if (slot.tag === "pending") return;
    if (slot.tag === "fresh" && now() - slot.atMs < TICKET_TTL_MS) return;
    const task = (async () => {
      try {
        const minted = await mint(await chatBearer());
        if (minted.tag === "token") return minted.token;
        failure = minted.reason;
        return null;
      } catch {
        failure = "NET";
        return null;
      }
    })();
    slot = { tag: "pending", task };
    void task.then((token) => {
      if (slot.tag !== "pending" || slot.task !== task) return;
      slot = token ? { tag: "fresh", token, atMs: now() } : { tag: "idle" };
    });
  }

  async function take(nowMs: number): Promise<ScribeToken | null> {
    let at = nowMs;
    for (;;) {
      if (slot.tag === "fresh" && at - slot.atMs < TICKET_TTL_MS) {
        const token = slot.token;
        slot = { tag: "idle" };
        begin();
        return token;
      }
      if (slot.tag !== "pending") begin();
      if (slot.tag !== "pending") return null;
      const token = await slot.task;
      at = now();
      if (!token) return null;
      const held = shelfNow();
      if (held.tag === "fresh" && held.token === token && at - held.atMs < TICKET_TTL_MS) {
        slot = { tag: "idle" };
        begin();
        return held.token;
      }
    }
  }

  return { warm: begin, take, failure: () => failure };
}

const MINT_REASONS: Readonly<Record<number, string>> = {
  401: "AUTH",
  502: "UPSTREAM",
  503: "NO-KEY",
};

async function mintScribeToken(bearer: string | null): Promise<Mint> {
  const headers: Record<string, string> = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let response: Response;
  try {
    response = await fetch("/api/stt/token", { method: "POST", headers });
  } catch {
    return { tag: "fail", reason: "NET" };
  }
  if (!response.ok) return { tag: "fail", reason: MINT_REASONS[response.status] ?? `HTTP-${response.status}` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { tag: "fail", reason: "BAD-BODY" };
  }
  if (!isRecord(body) || typeof body.token !== "string" || body.token.trim() === "") {
    return { tag: "fail", reason: "BAD-BODY" };
  }
  return { tag: "token", token: body.token as ScribeToken };
}

function micFault(error: unknown): string {
  const name = isRecord(error) || error instanceof Error ? (error as { name?: unknown }).name : undefined;
  if (name === "NotAllowedError" || name === "SecurityError") return "MIC-DENIED";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "MIC-NONE";
  return "MIC-ERR";
}

function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * LEVEL_GAIN);
}

function audioCtor(target: Window): AudioContextCtor | null {
  const view = target as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  if (typeof view.AudioContext === "function") return view.AudioContext;
  if (typeof view.webkitAudioContext === "function") return view.webkitAudioContext;
  return null;
}

function contextFor(target: Window): AudioContext | null {
  const Ctor = audioCtor(target);
  if (!Ctor) return null;
  const existing = contexts.get(target);
  if (existing) return existing;
  let ctx: AudioContext;
  try {
    ctx = new Ctor({ sampleRate: SCRIBE_HZ });
  } catch {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  contexts.set(target, ctx);
  return ctx;
}

function mediaGetter(target: Window): ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | null {
  const devices = target.navigator?.mediaDevices;
  const getUserMedia = devices?.getUserMedia;
  if (!devices || typeof getUserMedia !== "function") return null;
  return getUserMedia.bind(devices);
}

function canCapture(target: Window): boolean {
  return mediaGetter(target) !== null && audioCtor(target) !== null;
}

function armWindow(target: Window, warm: () => void): void {
  if (armedWindows.has(target)) return;
  armedWindows.add(target);
  const resume = (): void => {
    const ctx = contextFor(target);
    if (ctx) void ctx.resume().then(() => undefined, () => undefined);
    warm();
  };
  target.addEventListener("pointerdown", resume, true);
  target.addEventListener("touchstart", resume, true);
  target.addEventListener("click", resume, true);
}

function sendChunk(run: ScribeRun, audio: AudioChunk): void {
  const payload = JSON.stringify(audio);
  if (run.gate.tag === "closed") return;
  if (run.gate.tag === "connecting") {
    run.gate.queued.push({ payload, commit: audio.commit });
    return;
  }
  if (run.socket.readyState !== WebSocket.OPEN) {
    run.gate = { tag: "closed" };
    return;
  }
  ignore(() => run.socket.send(payload));
  if (audio.commit) run.commitSent = true;
}

function flush(run: ScribeRun): void {
  if (run.gate.tag !== "connecting") return;
  const queued = run.gate.queued;
  run.gate = { tag: "open" };
  for (const item of queued) {
    if (run.socket.readyState !== WebSocket.OPEN) {
      run.gate = { tag: "closed" };
      return;
    }
    ignore(() => run.socket.send(item.payload));
    if (item.commit) run.commitSent = true;
  }
}

const SERVER_FAULTS: ReadonlySet<string> = new Set([
  "quota_exceeded",
  "rate_limited",
  "commit_throttled",
  "unaccepted_terms",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "chunk_size_exceeded",
  "insufficient_audio_activity",
]);

function serverFault(type: unknown): string | null {
  if (typeof type !== "string") return null;
  if (type.includes("error") || SERVER_FAULTS.has(type)) return `SRV-${type.toUpperCase()}`;
  return null;
}

function applyScribeMessage(
  run: ScribeRun,
  raw: string,
  emitPartial: (text: string) => void,
  fault: (reason: string) => void,
): void {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(value)) return;
  const reason = serverFault(value.message_type);
  if (reason !== null) {
    fault(reason);
    return;
  }
  if (typeof value.text !== "string") return;
  if (value.message_type === "partial_transcript") {
    run.latestPartial = value.text;
    emitPartial(value.text);
    return;
  }
  if (value.message_type === "committed_transcript") {
    run.committedText += value.text;
    if (run.commitSent) run.finishStop?.();
  }
}

function audioChunk(audio: string, commit: boolean): AudioChunk {
  return {
    message_type: "input_audio_chunk",
    audio_base_64: audio,
    commit,
    sample_rate: SCRIBE_HZ,
  };
}

function socketCtor(target: Window): SocketCtor | null {
  const view = target as Window & { WebSocket?: SocketCtor };
  if (typeof view.WebSocket === "function") return view.WebSocket;
  if (typeof WebSocket === "function") return WebSocket;
  return null;
}

function stopRun(run: ScribeRun, stopTracks: () => void, tailMs: number): Promise<string> {
  if (run.stopGate) return run.stopGate;
  let resolveStop: (text: string) => void = () => {};
  const gate = new Promise<string>((resolve) => {
    resolveStop = resolve;
  });
  run.stopGate = gate;
  let done = false;
  let tailTimer: ReturnType<typeof setTimeout> | null = null;
  let waitTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (): void => {
    if (done) return;
    done = true;
    if (tailTimer !== null) clearTimeout(tailTimer);
    if (waitTimer !== null) clearTimeout(waitTimer);
    run.sealed = true;
    stopTracks();
    run.gate = { tag: "closed" };
    ignore(() => {
      if (run.socket.readyState === WebSocket.OPEN || run.socket.readyState === WebSocket.CONNECTING) run.socket.close();
    });
    resolveStop(run.committedText.trim() || run.latestPartial.trim());
  };
  run.finishStop = finish;
  const seal = (): void => {
    if (done) return;
    run.sealed = true;
    stopTracks();
    sendChunk(run, audioChunk("", true));
    if (done) return;
    waitTimer = setTimeout(finish, COMMIT_WAIT_MS);
    if (run.gate.tag === "closed" || run.socket.readyState === WebSocket.CLOSED) finish();
  };
  if (tailMs > 0) tailTimer = setTimeout(seal, tailMs);
  else seal();
  return gate;
}

function openListen(env: ScribeEnv, shelf: Shelf, callbacks: StreamCallbacks): Promise<StreamSession | null> {
  let stopTracks = (): void => {};
  const tailMs = env.tailMs ?? TAIL_MS;
  let reported = false;
  const fail = (reason: string): void => {
    if (reported) return;
    reported = true;
    callbacks.onFail?.(reason);
  };
  return (async (): Promise<StreamSession | null> => {
    const token = await shelf.take(env.now());
    if (!token) {
      fail(shelf.failure());
      return null;
    }
    const ctx = contextFor(env.target);
    const getUserMedia = mediaGetter(env.target);
    const Ctor = socketCtor(env.target);
    if (!ctx || !getUserMedia || !Ctor) {
      fail("NO-API");
      return null;
    }
    void ctx.resume().then(
      () => undefined,
      () => undefined,
    );
    let stream: MediaStream;
    try {
      stream = await getUserMedia({ audio: MIC_CONSTRAINTS });
    } catch (error) {
      fail(micFault(error));
      return null;
    }
    const tracks = stream.getTracks();
    let processor: ScriptProcessorNode | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let gain: GainNode | null = null;
    let released = false;
    stopTracks = () => {
      if (released) return;
      released = true;
      for (const track of tracks) ignore(() => track.stop());
      ignore(() => processor?.disconnect());
      ignore(() => source?.disconnect());
      ignore(() => gain?.disconnect());
      if (processor) processor.onaudioprocess = null;
      processor = null;
      source = null;
      gain = null;
    };
    let socket: WebSocket;
    try {
      socket = new Ctor(scribeSocketUrl(token));
    } catch {
      stopTracks();
      fail("WS-FAIL");
      return null;
    }
    const run: ScribeRun = {
      committedText: "",
      latestPartial: "",
      gate: { tag: "connecting", queued: [] },
      socket,
      stopGate: null,
      commitSent: false,
      sealed: false,
      finishStop: null,
    };
    let opened = false;
    let settled = false;
    let live = false;
    let cancelled = false;
    const emit = (text: string): void => {
      if (live) callbacks.onPartial(text);
    };
    const session = await new Promise<StreamSession | null>((resolve) => {
      const finish = (value: StreamSession | null, reason: string = "WS-FAIL"): void => {
        if (settled) return;
        settled = true;
        if (value === null) {
          fail(reason);
          stopTracks();
          ignore(() => socket.close());
        }
        resolve(value);
      };
      const handle: StreamSession = {
        stop: () => stopRun(run, stopTracks, tailMs),
        cancel() {
          cancelled = true;
          stopTracks();
          run.gate = { tag: "closed" };
          ignore(() => socket.close());
        },
      };
      const markOpen = (): void => {
        if (opened) return;
        opened = true;
        flush(run);
        finish(handle);
        queueMicrotask(() => {
          live = true;
          if (run.latestPartial !== "") callbacks.onPartial(run.latestPartial);
        });
      };
      socket.onmessage = (event: MessageEvent) => {
        applyScribeMessage(run, typeof event.data === "string" ? event.data : "", emit, fail);
      };
      socket.onerror = () => {
        if (!opened) finish(null);
      };
      socket.onclose = () => {
        run.gate = { tag: "closed" };
        if (!opened) {
          finish(null);
          return;
        }
        if (!run.stopGate && !cancelled) fail("WS-CLOSED");
        run.finishStop?.();
      };
      socket.onopen = () => markOpen();
      try {
        source = ctx.createMediaStreamSource(stream);
        processor = ctx.createScriptProcessor(PCM_WINDOW, 1, 1);
        gain = ctx.createGain();
        gain.gain.value = 0;
        processor.onaudioprocess = (event) => {
          if (run.sealed) return;
          const block = new Float32Array(event.inputBuffer.getChannelData(0));
          callbacks.onLevel?.(rmsLevel(block));
          const audio = pcm16Base64(block, event.inputBuffer.sampleRate);
          if (audio === "") return;
          sendChunk(run, audioChunk(audio, false));
        };
        source.connect(processor);
        processor.connect(gain);
        gain.connect(ctx.destination);
      } catch {
        finish(null, "AUDIO");
        return;
      }
      if (socket.readyState === WebSocket.OPEN) markOpen();
    });
    if (!session) stopTracks();
    return session;
  })().catch(() => {
    stopTracks();
    return null;
  });
}

export function createScribeListen(env: ScribeEnv): StreamListen {
  const shelf = createShelf(mintScribeToken, env.now, env.chatBearer);
  armWindow(env.target, () => shelf.warm());
  return (callbacks) => {
    if (!canCapture(env.target)) {
      callbacks.onFail?.("NO-API");
      return null;
    }
    return openListen(env, shelf, callbacks);
  };
}
