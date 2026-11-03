export const TTS_PATH = "/api/tts" as const;
export const TTS_UNCONFIGURED = "tts-unconfigured" as const;

export type AudibleReply = string & { readonly __brand: "AudibleReply" };
export type SpeakId = number & { readonly __brand: "SpeakId" };

export type SpeakOutcome =
  | { readonly tag: "spoken" }
  | { readonly tag: "dropped" }
  | { readonly tag: "no-key" }
  | { readonly tag: "failed" };

export type MouthNote = "quiet" | "no-key" | "failed";

export function audibleReply(text: string): AudibleReply | null {
  if (text.trim() === "") return null;
  return text as AudibleReply;
}

export function nextSpeakId(current: SpeakId): SpeakId {
  return (current + 1) as SpeakId;
}

export function noteOf(outcome: SpeakOutcome): Exclude<MouthNote, "quiet"> | null {
  switch (outcome.tag) {
    case "spoken":
    case "dropped":
      return null;
    case "no-key":
    case "failed":
      return outcome.tag;
    default: {
      const unreachable: never = outcome;
      return unreachable;
    }
  }
}

export const MOUTH_COPY = {
  "no-key": "NO TTS KEY",
  failed: "TTS FAIL",
} as const satisfies Record<Exclude<MouthNote, "quiet">, string>;
