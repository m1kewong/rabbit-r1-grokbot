import {
  LOCAL_MODEL,
  parsePersonaId,
  plainUtterance,
  type ChatResult,
  type ChatTurn,
  type HealthStatus,
  type PersonaId,
  type UpstreamModel,
} from "./domain";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceChatResult(value: unknown, fallbackPersona: PersonaId): ChatResult {
  if (!isRecord(value) || value.ok !== true || typeof value.reply !== "string") {
    return { ok: false, error: "network" };
  }
  const personaId = parsePersonaId(value.personaId ?? fallbackPersona);
  if (value.routedToGrokBot === true && typeof value.model === "string" && value.model !== LOCAL_MODEL) {
    const model = value.model as UpstreamModel;
    return { ok: true, reply: value.reply, model, personaId, routedToGrokBot: true };
  }
  return { ok: true, reply: value.reply, model: LOCAL_MODEL, personaId, routedToGrokBot: false };
}

export async function postChat(input: {
  readonly message: string;
  readonly personaId: PersonaId;
  readonly history: readonly ChatTurn[];
  readonly token: string | null;
}): Promise<ChatResult> {
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stark-persona": input.personaId,
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
      body: JSON.stringify({
        message: plainUtterance(input.message),
        personaId: input.personaId,
        history: input.history,
        token: input.token,
      }),
    });
    if (!response.ok) return { ok: false, error: "network" };
    return coerceChatResult(await response.json(), input.personaId);
  } catch {
    return { ok: false, error: "network" };
  }
}

export async function getHealth(): Promise<HealthStatus | { readonly ok: false; readonly error: "network" }> {
  try {
    const response = await fetch("/health");
    if (!response.ok) return { ok: false, error: "network" };
    const body: unknown = await response.json();
    if (
      isRecord(body) &&
      body.ok === true &&
      body.service === "stark-r1-openclaw" &&
      body.protocolMin === 3 &&
      body.protocolMax === 4
    ) {
      return { ok: true, service: "stark-r1-openclaw", protocolMin: 3, protocolMax: 4 };
    }
    return { ok: false, error: "network" };
  } catch {
    return { ok: false, error: "network" };
  }
}
