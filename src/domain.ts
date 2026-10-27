export const FRAME_COLOR = "#FE5000" as const;

export const PERSONAS = [
  {
    id: "friday",
    label: "F.R.I.D.A.Y.",
    role: "AGI Chief",
    accents: ["#FF4D00", "#F59E0B"],
  },
  {
    id: "jarvis",
    label: "J.A.R.V.I.S.",
    role: "Lead Engineer",
    accents: ["#38BDF8"],
  },
  {
    id: "edith",
    label: "E.D.I.T.H.",
    role: "Comms",
    accents: ["#A855F7"],
  },
  {
    id: "ev",
    label: "E.V.",
    role: "Product Alert",
    accents: ["#10B981"],
  },
  {
    id: "karen",
    label: "Karen",
    role: "Calendar",
    accents: ["#EC4899"],
  },
  {
    id: "dume",
    label: "Dum-E",
    role: "Ops Dump",
    accents: ["#EAB308"],
  },
] as const;

export type AssertFridayFirst = (typeof PERSONAS)[0]["id"] extends "friday" ? true : never;

const fridayIsFirst: AssertFridayFirst = true;
void fridayIsFirst;

export type Persona = (typeof PERSONAS)[number];
export type PersonaId = Persona["id"];

export const QUICK_PRESETS = [
  { id: "status", text: "Give me a status report." },
  { id: "brief", text: "Brief me on what matters today." },
  { id: "focus", text: "What should I focus on?" },
  { id: "scan", text: "Scan for anything urgent." },
] as const;

export type PresetId = (typeof QUICK_PRESETS)[number]["id"];

export type ChatTurn = {
  readonly role: "user" | "assistant";
  readonly content: string;
};

export const LOCAL_MODEL = "local-friday" as const;

export type UpstreamModel = string & { readonly __brand: "UpstreamModel" };

export type ChatResult =
  | {
      readonly ok: true;
      readonly reply: string;
      readonly model: UpstreamModel;
      readonly personaId: PersonaId;
      readonly routedToGrokBot: true;
    }
  | {
      readonly ok: true;
      readonly reply: string;
      readonly model: typeof LOCAL_MODEL;
      readonly personaId: PersonaId;
      readonly routedToGrokBot: false;
    }
  | { readonly ok: false; readonly error: "bad-request" | "network" };

export type HealthStatus = {
  readonly ok: true;
  readonly service: "stark-r1-openclaw";
  readonly protocolMin: 3;
  readonly protocolMax: 4;
};

export function parsePersonaId(value: unknown): PersonaId {
  if (typeof value !== "string") return "friday";
  for (const persona of PERSONAS) {
    if (persona.id === value) return persona.id;
  }
  return "friday";
}

export function personaById(id: PersonaId): Persona {
  for (const persona of PERSONAS) {
    if (persona.id === id) return persona;
  }
  throw new Error(`unknown persona ${id}`);
}

const NAMED_PREFIX = /^(?:\[R1 -> [^\]]+\]|\[Agent: [^\]]+\])\s*/;

export function plainUtterance(text: string): string {
  let next = text;
  for (;;) {
    const stripped = next.replace(NAMED_PREFIX, "");
    if (stripped === next) return next;
    next = stripped;
  }
}

export function neighbor(id: PersonaId, direction: "up" | "down"): PersonaId {
  const index = PERSONAS.findIndex((persona) => persona.id === id);
  const delta = direction === "down" ? 1 : -1;
  const next = (index + delta + PERSONAS.length) % PERSONAS.length;
  const persona = PERSONAS[next];
  if (!persona) throw new Error("roster index");
  return persona.id;
}

export function presetById(id: PresetId): (typeof QUICK_PRESETS)[number] {
  for (const preset of QUICK_PRESETS) {
    if (preset.id === id) return preset;
  }
  throw new Error(`unknown preset ${id}`);
}

export function nextPreset(id: PresetId): PresetId {
  const index = QUICK_PRESETS.findIndex((preset) => preset.id === id);
  const preset = QUICK_PRESETS[(index + 1) % QUICK_PRESETS.length];
  if (!preset) throw new Error("preset index");
  return preset.id;
}
