import {
  neighbor,
  nextPreset,
  presetById,
  type ChatTurn,
  type PersonaId,
  type PresetId,
} from "./domain";

const SIDE_CLICK_MS = 250 as const;

export type Gesture =
  | { readonly tag: "idle" }
  | { readonly tag: "side-pending"; readonly sinceMs: number }
  | { readonly tag: "ptt-armed" }
  | { readonly tag: "awaiting-utterance" }
  | { readonly tag: "drafting" };

export type Turn =
  | { readonly tag: "idle" }
  | { readonly tag: "pending"; readonly text: string }
  | { readonly tag: "done"; readonly text: string; readonly reply: string }
  | { readonly tag: "failed" }
  | { readonly tag: "silent"; readonly ear?: "r1" }
  | { readonly tag: "no-mic" };

export type DeviceState = {
  readonly personaId: PersonaId;
  readonly composer: string;
  readonly presetId: PresetId;
  readonly gesture: Gesture;
  readonly speakerOn: boolean;
  readonly token: string | null;
  readonly turn: Turn;
  readonly transcript: readonly ChatTurn[];
};

export type DeviceEvent =
  | { readonly type: "scroll"; readonly direction: "up" | "down" }
  | { readonly type: "composer"; readonly text: string }
  | { readonly type: "sideClick"; readonly nowMs: number }
  | { readonly type: "sideTimer"; readonly nowMs: number }
  | { readonly type: "longPressStart" }
  | { readonly type: "longPressEnd" }
  | { readonly type: "utterance"; readonly heard: string | null; readonly ear?: "r1" | "absent" }
  | { readonly type: "toggleDraft" }
  | { readonly type: "sendDraft" }
  | { readonly type: "toggleSpeaker" }
  | { readonly type: "token"; readonly token: string | null }
  | { readonly type: "reply"; readonly sent: string; readonly reply: string | null }
  | { readonly type: "exit" };

export type SpeakPayload = {
  readonly message: string;
  readonly useLLM: true;
  readonly wantsR1Response: true;
  readonly wantsJournalEntry: false;
};

export type DeviceEffect =
  | {
      readonly type: "submit";
      readonly text: string;
      readonly personaId: PersonaId;
      readonly history: readonly ChatTurn[];
    }
  | { readonly type: "speak"; readonly payload: SpeakPayload }
  | {
      readonly type: "armSideTimer";
      readonly fireAtMs: number;
      readonly delayMs: typeof SIDE_CLICK_MS;
    }
  | { readonly type: "ptt-start" }
  | { readonly type: "ptt-stop" }
  | { readonly type: "cancel-wait" }
  | { readonly type: "closeWebView" };

export type DeviceStep = {
  readonly state: DeviceState;
  readonly effects: readonly DeviceEffect[];
};

export function initialDevice(): DeviceState {
  return {
    personaId: "friday",
    composer: "",
    presetId: "status",
    gesture: { tag: "idle" },
    speakerOn: false,
    token: null,
    turn: { tag: "idle" },
    transcript: [],
  };
}

function same(state: DeviceState, effects: readonly DeviceEffect[] = []): DeviceStep {
  return { state, effects };
}

function promptText(state: DeviceState): string {
  if (state.composer.length > 0) return state.composer;
  return presetById(state.presetId).text;
}

function submit(state: DeviceState, text: string): DeviceStep {
  const history = state.transcript;
  return {
    state: {
      ...state,
      composer: "",
      gesture: { tag: "idle" },
      turn: { tag: "pending", text },
      transcript: [...state.transcript, { role: "user", content: text }],
    },
    effects: [{ type: "submit", text, personaId: state.personaId, history }],
  };
}

function onSideClick(state: DeviceState, nowMs: number): DeviceStep {
  if (state.gesture.tag === "ptt-armed" || state.gesture.tag === "awaiting-utterance") {
    return same(state);
  }
  if (state.gesture.tag === "side-pending" && nowMs - state.gesture.sinceMs < SIDE_CLICK_MS) {
    return {
      state: { ...state, presetId: nextPreset(state.presetId), gesture: { tag: "idle" } },
      effects: [{ type: "cancel-wait" }],
    };
  }
  if (state.gesture.tag === "side-pending") return same(state);
  return {
    state: { ...state, gesture: { tag: "side-pending", sinceMs: nowMs } },
    effects: [{ type: "armSideTimer", fireAtMs: nowMs + SIDE_CLICK_MS, delayMs: 250 }],
  };
}

function onSideTimer(state: DeviceState, nowMs: number): DeviceStep {
  if (state.gesture.tag !== "side-pending") return same(state);
  if (nowMs - state.gesture.sinceMs < SIDE_CLICK_MS) return same(state);
  const idle = { ...state, gesture: { tag: "idle" as const } };
  if (state.turn.tag === "pending") return same(idle);
  return submit(state, promptText(state));
}

function onLongPressStart(state: DeviceState): DeviceStep {
  if (state.gesture.tag === "ptt-armed") return same(state);
  const cancel = state.gesture.tag === "side-pending";
  return {
    state: { ...state, gesture: { tag: "ptt-armed" } },
    effects: cancel
      ? [{ type: "cancel-wait" }, { type: "ptt-start" }]
      : [{ type: "ptt-start" }],
  };
}

function onLongPressEnd(state: DeviceState): DeviceStep {
  if (state.gesture.tag !== "ptt-armed") return same(state);
  return {
    state: { ...state, gesture: { tag: "awaiting-utterance" } },
    effects: [{ type: "ptt-stop" }],
  };
}

function onToggleDraft(state: DeviceState): DeviceStep {
  if (state.gesture.tag === "ptt-armed" || state.gesture.tag === "awaiting-utterance") return same(state);
  if (state.gesture.tag === "drafting") return same({ ...state, gesture: { tag: "idle" } });
  if (state.gesture.tag === "side-pending") {
    return { state: { ...state, gesture: { tag: "drafting" } }, effects: [{ type: "cancel-wait" }] };
  }
  return same({ ...state, gesture: { tag: "drafting" } });
}

function onSendDraft(state: DeviceState): DeviceStep {
  if (state.gesture.tag !== "drafting") return same(state);
  const text = state.composer.trim();
  if (text === "" || state.turn.tag === "pending") return same({ ...state, gesture: { tag: "idle" } });
  return submit(state, text);
}

function onUtterance(state: DeviceState, heard: string | null, ear?: "r1" | "absent"): DeviceStep {
  if (state.gesture.tag !== "awaiting-utterance") return same(state);
  if (state.turn.tag === "pending") return same({ ...state, gesture: { tag: "idle" } });
  if (ear === "absent") return same({ ...state, gesture: { tag: "idle" }, turn: { tag: "no-mic" } });
  const text = heard?.trim() ?? "";
  if (text === "") {
    return same({
      ...state,
      gesture: { tag: "idle" },
      turn: ear === "r1" ? { tag: "silent", ear: "r1" } : { tag: "silent" },
    });
  }
  return submit(state, text);
}

function onReply(state: DeviceState, sent: string, reply: string | null): DeviceStep {
  if (state.turn.tag !== "pending" || state.turn.text !== sent) return same(state);
  if (reply === null) return same({ ...state, turn: { tag: "failed" } });
  const next: DeviceState = {
    ...state,
    turn: { tag: "done", text: sent, reply },
    transcript: [...state.transcript, { role: "assistant", content: reply }],
  };
  if (!state.speakerOn) return same(next);
  return {
    state: next,
    effects: [
      {
        type: "speak",
        payload: {
          message: reply,
          useLLM: true,
          wantsR1Response: true,
          wantsJournalEntry: false,
        },
      },
    ],
  };
}

export function reduceDevice(state: DeviceState, event: DeviceEvent): DeviceStep {
  switch (event.type) {
    case "scroll":
      return same({ ...state, personaId: neighbor(state.personaId, event.direction) });
    case "composer":
      return same({
        ...state,
        composer: event.text,
        turn: state.turn.tag === "silent" || state.turn.tag === "no-mic" ? { tag: "idle" } : state.turn,
      });
    case "token":
      return same({ ...state, token: event.token });
    case "toggleSpeaker":
      return same({ ...state, speakerOn: !state.speakerOn });
    case "exit":
      return { state, effects: [{ type: "closeWebView" }] };
    case "sideClick":
      return onSideClick(state, event.nowMs);
    case "sideTimer":
      return onSideTimer(state, event.nowMs);
    case "longPressStart":
      return onLongPressStart(state);
    case "longPressEnd":
      return onLongPressEnd(state);
    case "toggleDraft":
      return onToggleDraft(state);
    case "sendDraft":
      return onSendDraft(state);
    case "utterance":
      return onUtterance(state, event.heard, event.ear);
    case "reply":
      return onReply(state, event.sent, event.reply);
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}
