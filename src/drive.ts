import { postChat } from "./client";
import {
  initialDevice,
  reduceDevice,
  type DeviceEffect,
  type DeviceEvent,
  type DeviceState,
  type SpeakPayload,
} from "./device";

export type StreamSession = {
  stop(): Promise<string | null>;
  cancel(): void;
};

export type StreamCallbacks = {
  onPartial(text: string): void;
  onLevel?(level: number): void;
  onFail?(reason: string): void;
};

export type StreamListen = (callbacks: StreamCallbacks) => StreamSession | null | Promise<StreamSession | null>;

export type DrivePorts = {
  now(): number;
  loadToken(): Promise<string | null>;
  capture(): Promise<string | null>;
  speak(payload: SpeakPayload): void;
  exit(): void;
  schedule(delayMs: number, fire: () => void): () => void;
  render(state: DeviceState, dispatch: (event: DeviceEvent) => void): void;
  viewport?: { addEventListener(type: "resize", listener: () => void): void };
  pluginTarget?: {
    onPluginMessage?: (data: unknown) => void;
    CreationVoiceHandler?: { postMessage(message: string): void };
  };
  hasMic?: () => boolean;
  streamListen?: StreamListen;
};

const STT_GRACE_MS = 1_200;

type Ear =
  | { readonly tag: "opening" }
  | { readonly tag: "stream"; readonly session: StreamSession }
  | { tag: "native"; transcript: string | null; cancelGrace: (() => void) | null }
  | { tag: "capture"; transcript: string | null; readonly pending: Promise<string | null> }
  | { readonly tag: "absent" };

type ListenSession = {
  readonly generation: number;
  phase: "holding" | "released";
  ear: Ear;
  fail: string | null;
};

type VoiceBridge = { postMessage(message: string): void };

type ReplySlot = {
  sent: string;
  ready: boolean;
  reply: string | null;
};

export function startDrive(ports: DrivePorts): {
  control(name: string): void;
  wheel(deltaY: number): void;
} {
  let state = initialDevice();
  const queue: DeviceEvent[] = [];
  let pumping = false;
  let cancelTimer: (() => void) | null = null;
  let generation = 0;
  let listen: ListenSession | null = null;
  const slots: ReplySlot[] = [];

  const dispatch = (event: DeviceEvent): void => {
    queue.push(event);
    pump();
  };

  function pump(): void {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        const event = queue.shift();
        if (!event) break;
        const step = reduceDevice(state, event);
        state = step.state;
        for (const effect of step.effects) runEffect(effect);
        ports.render(state, dispatch);
      }
    } finally {
      pumping = false;
      if (queue.length > 0) pump();
    }
  }

  function drainReplies(): void {
    while (slots[0]?.ready) {
      const slot = slots.shift();
      if (!slot) return;
      dispatch({ type: "reply", sent: slot.sent, reply: slot.reply });
    }
  }

  function runEffect(effect: DeviceEffect): void {
    switch (effect.type) {
      case "armSideTimer":
        cancelTimer?.();
        cancelTimer = ports.schedule(effect.delayMs, () => {
          cancelTimer = null;
          dispatch({ type: "sideTimer", nowMs: effect.fireAtMs });
        });
        break;
      case "cancel-wait":
        cancelTimer?.();
        cancelTimer = null;
        break;
      case "submit": {
        const slot: ReplySlot = { sent: effect.text, ready: false, reply: null };
        slots.push(slot);
        void postChat({
          message: effect.text,
          personaId: effect.personaId,
          history: effect.history,
          token: state.token,
        }).then((result) => {
          slot.ready = true;
          slot.reply = result.ok ? result.reply : null;
          drainReplies();
        });
        break;
      }
      case "ptt-start":
        beginListen();
        break;
      case "ptt-stop":
        endListen();
        break;
      case "speak":
        ports.speak(effect.payload);
        break;
      case "closeWebView":
        ports.exit();
        break;
      default: {
        const unreachable: never = effect;
        return unreachable;
      }
    }
  }

  function voiceHandler(): VoiceBridge | null {
    return bridgeOf(ports.pluginTarget) ?? bridgeOf(globalThis);
  }

  function owns(session: ListenSession): boolean {
    return listen?.generation === session.generation;
  }

  function isPromise(value: StreamSession | Promise<StreamSession | null>): value is Promise<StreamSession | null> {
    return typeof (value as { then?: unknown }).then === "function";
  }

  function deliver(session: ListenSession, heard: string | null, ear?: "r1" | "absent"): void {
    if (!owns(session)) return;
    if (session.ear.tag === "native") {
      session.ear.cancelGrace?.();
      session.ear.cancelGrace = null;
    }
    listen = null;
    dispatch(ear ? { type: "utterance", heard, ear } : { type: "utterance", heard });
  }

  function fillHandset(session: ListenSession): void {
    if (!owns(session) || session.phase !== "holding") return;
    const handler = voiceHandler();
    if (handler) {
      session.ear = { tag: "native", transcript: null, cancelGrace: null };
      dispatch({ type: "ear", engine: "r1", note: session.fail });
      try {
        handler.postMessage("start");
      } catch {
        if (session.ear.tag === "native") session.ear.transcript = "";
      }
      return;
    }
    if (ports.hasMic && !ports.hasMic()) {
      session.ear = { tag: "absent" };
      dispatch({ type: "ear", engine: "none", note: session.fail });
      return;
    }
    dispatch({ type: "ear", engine: "browser", note: session.fail });
    const pending = ports.capture();
    session.ear = { tag: "capture", transcript: null, pending };
    void pending.then(
      (heard) => {
        if (!owns(session) || session.ear.tag !== "capture") return;
        session.ear.transcript = heard ?? "";
        if (session.phase === "released") deliver(session, session.ear.transcript);
      },
      () => {
        if (!owns(session) || session.ear.tag !== "capture") return;
        session.ear.transcript = "";
        if (session.phase === "released") deliver(session, "");
      },
    );
  }

  function finishOpen(session: ListenSession, handle: StreamSession | null): void {
    if (!owns(session)) {
      handle?.cancel();
      return;
    }
    if (handle === null) {
      if (session.phase === "holding") fillHandset(session);
      else deliver(session, "");
      return;
    }
    session.ear = { tag: "stream", session: handle };
    dispatch({ type: "ear", engine: "scribe", note: session.fail });
    if (session.phase === "released") {
      void handle.stop().then(
        (text) => deliver(session, text),
        () => deliver(session, ""),
      );
    }
  }

  function beginListen(): void {
    const session: ListenSession = {
      generation: (generation += 1),
      phase: "holding",
      ear: { tag: "opening" },
      fail: null,
    };
    listen = session;
    let started: StreamSession | null | Promise<StreamSession | null> | undefined;
    try {
      started = ports.streamListen?.({
        onPartial(text) {
          if (!owns(session) || session.ear.tag !== "stream") return;
          dispatch({ type: "partial", text });
        },
        onLevel(level) {
          if (!owns(session) || session.phase !== "holding") return;
          if (session.ear.tag !== "stream" && session.ear.tag !== "opening") return;
          dispatch({ type: "level", level });
        },
        onFail(reason) {
          if (!owns(session)) return;
          session.fail = reason;
          if (session.ear.tag === "stream") dispatch({ type: "ear", engine: "scribe", note: reason });
        },
      });
    } catch {
      started = null;
    }
    if (started === undefined || started === null) {
      fillHandset(session);
      return;
    }
    if (isPromise(started)) {
      void started.then(
        (handle) => finishOpen(session, handle),
        () => finishOpen(session, null),
      );
      return;
    }
    session.ear = { tag: "stream", session: started };
    dispatch({ type: "ear", engine: "scribe", note: session.fail });
  }

  function endListen(): void {
    const session = listen;
    if (!session) {
      dispatch({ type: "utterance", heard: null });
      return;
    }
    if (session.phase === "released") return;
    session.phase = "released";
    switch (session.ear.tag) {
      case "opening":
        return;
      case "stream": {
        const handle = session.ear.session;
        void handle.stop().then(
          (text) => deliver(session, text),
          () => deliver(session, ""),
        );
        return;
      }
      case "native": {
        try {
          voiceHandler()?.postMessage("stop");
        } catch {
          deliver(session, session.ear.transcript ?? "", "r1");
          return;
        }
        if (!owns(session)) return;
        if (session.ear.transcript !== null) {
          deliver(session, session.ear.transcript, "r1");
          return;
        }
        session.ear.cancelGrace = ports.schedule(STT_GRACE_MS, () => {
          if (!owns(session)) return;
          deliver(session, "", "r1");
        });
        return;
      }
      case "absent":
        deliver(session, null, "absent");
        return;
      case "capture":
        if (session.ear.transcript !== null) deliver(session, session.ear.transcript);
        return;
      default: {
        const unreachable: never = session.ear;
        return unreachable;
      }
    }
  }

  if (ports.pluginTarget) {
    ports.pluginTarget.onPluginMessage = (data: unknown) => {
      const transcript = readSttEnded(data);
      if (transcript === undefined) return;
      const session = listen;
      if (!session || session.ear.tag !== "native") return;
      session.ear.transcript = transcript;
      if (session.phase !== "released") return;
      deliver(session, transcript, "r1");
    };
  }
  ports.viewport?.addEventListener("resize", () => {
    ports.render(state, dispatch);
  });
  ports.render(state, dispatch);
  void ports.loadToken().then((token) => {
    if (token) dispatch({ type: "token", token });
  });

  return {
    control(name) {
      const event = controlEvent(name, ports.now());
      if (event) dispatch(event);
    },
    wheel(deltaY) {
      if (deltaY > 0) dispatch({ type: "scroll", direction: "down" });
      else if (deltaY < 0) dispatch({ type: "scroll", direction: "up" });
    },
  };
}

function controlEvent(name: string, nowMs: number): DeviceEvent | null {
  switch (name) {
    case "scrollUp":
      return { type: "scroll", direction: "up" };
    case "scrollDown":
      return { type: "scroll", direction: "down" };
    case "sideClick":
      return { type: "sideClick", nowMs };
    case "longPressStart":
      return { type: "longPressStart" };
    case "longPressEnd":
      return { type: "longPressEnd" };
    case "toggleSpeaker":
      return { type: "toggleSpeaker" };
    case "exit":
      return { type: "exit" };
    default:
      return null;
  }
}

function bridgeOf(source: unknown): VoiceBridge | null {
  if (typeof source !== "object" || source === null) return null;
  const handler = (source as { CreationVoiceHandler?: { postMessage?: unknown } }).CreationVoiceHandler;
  if (!handler || typeof handler.postMessage !== "function") return null;
  return handler as VoiceBridge;
}

function readSttEnded(data: unknown): string | undefined {
  const record = pluginRecord(data);
  if (!record || record.type !== "sttEnded") return undefined;
  return typeof record.transcript === "string" ? record.transcript : "";
}

function pluginRecord(data: unknown): Record<string, unknown> | null {
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (trimmed === "") return null;
    try {
      return pluginRecord(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}
