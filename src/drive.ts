import { postChat } from "./client";
import {
  initialDevice,
  reduceDevice,
  type DeviceEffect,
  type DeviceEvent,
  type DeviceState,
  type SpeakPayload,
} from "./device";

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
};

const STT_GRACE_MS = 1_200;

type ListenSession = {
  native: boolean;
  absent: boolean;
  stopped: boolean;
  transcript: string | null;
  pending: Promise<string | null> | null;
  cancelGrace: (() => void) | null;
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

  function deliver(session: ListenSession, heard: string | null, ear?: "r1" | "absent"): void {
    if (listen !== session) return;
    session.cancelGrace?.();
    session.cancelGrace = null;
    listen = null;
    dispatch(ear ? { type: "utterance", heard, ear } : { type: "utterance", heard });
  }

  function beginListen(): void {
    const handler = voiceHandler();
    if (handler) {
      const session: ListenSession = {
        native: true,
        absent: false,
        stopped: false,
        transcript: null,
        pending: null,
        cancelGrace: null,
      };
      listen = session;
      try {
        handler.postMessage("start");
      } catch {
        session.transcript = "";
      }
      return;
    }
    if (ports.hasMic && !ports.hasMic()) {
      listen = {
        native: false,
        absent: true,
        stopped: false,
        transcript: "",
        pending: null,
        cancelGrace: null,
      };
      return;
    }
    const session: ListenSession = {
      native: false,
      absent: false,
      stopped: false,
      transcript: null,
      pending: ports.capture(),
      cancelGrace: null,
    };
    listen = session;
    void session.pending?.then(
      (heard) => {
        if (listen !== session) return;
        session.transcript = heard ?? "";
        if (session.stopped) deliver(session, session.transcript);
      },
      () => {
        if (listen !== session) return;
        session.transcript = "";
        if (session.stopped) deliver(session, "");
      },
    );
  }

  function endListen(): void {
    const session = listen;
    if (!session) {
      dispatch({ type: "utterance", heard: null });
      return;
    }
    session.stopped = true;
    if (session.absent) {
      deliver(session, null, "absent");
      return;
    }
    if (session.native) {
      try {
        voiceHandler()?.postMessage("stop");
      } catch {
        deliver(session, session.transcript ?? "", "r1");
        return;
      }
      if (listen !== session) return;
      if (session.transcript !== null) {
        deliver(session, session.transcript, "r1");
        return;
      }
      session.cancelGrace = ports.schedule(STT_GRACE_MS, () => {
        if (listen !== session) return;
        deliver(session, "", "r1");
      });
      return;
    }
    if (session.transcript !== null) deliver(session, session.transcript);
  }

  if (ports.pluginTarget) {
    ports.pluginTarget.onPluginMessage = (data: unknown) => {
      const transcript = readSttEnded(data);
      if (transcript === undefined) return;
      const session = listen;
      if (!session?.native) return;
      session.transcript = transcript;
      if (!session.stopped) return;
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
