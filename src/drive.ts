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
  pluginTarget?: { onPluginMessage?: (data: unknown) => void };
};

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
      case "capture-speech":
        void ports.capture().then((heard) => {
          dispatch({ type: "utterance", heard });
        });
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

  if (ports.pluginTarget) {
    ports.pluginTarget.onPluginMessage = (data: unknown) => {
      const heard = pluginText(data);
      if (heard !== null) dispatch({ type: "utterance", heard });
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

function pluginText(data: unknown): string | null {
  if (typeof data === "string") {
    const trimmed = data.trim();
    if (trimmed === "") return null;
    try {
      return pluginText(JSON.parse(trimmed) as unknown);
    } catch {
      return trimmed;
    }
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  for (const key of ["transcript", "message", "text"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
