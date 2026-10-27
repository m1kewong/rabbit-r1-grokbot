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

export const LIMITS = {
  maxPayload: 1_048_576,
  maxBufferedBytes: 4_194_304,
  tickIntervalMs: 15_000,
} as const;

const SERVER_MIN = 3 as const;
const SERVER_MAX = 4 as const;
const SERVER_VERSION = "stark-r1-openclaw/1.0.0" as const;
const DEFAULT_BRIDGE = "https://even-g2-bridge.saviormike.workers.dev";
const OFFLINE_PREFIX = "F.R.I.D.A.Y. is offline. Heard: ";
const TICK_SLACK_MS = 250;

const FEATURE_METHODS = [
  "chat.send",
  "chat.abort",
  "chat.subscribe",
  "chat.history",
  "agent",
  "sessions.send",
  "agent.wait",
  "talk.session.create",
] as const;

const FEATURE_EVENTS = ["chat", "agent", "tick", "heartbeat"] as const;

const HANDLERS = {
  "chat.send": "talk",
  agent: "talk",
  "sessions.send": "talk",
  "chat.abort": "abort",
  "chat.subscribe": "subscribe",
  "chat.history": "history",
  "agent.wait": "wait",
  "talk.session.create": "createTalk",
} as const;

type FeatureMethod = (typeof FEATURE_METHODS)[number];
type MethodKind = typeof HANDLERS;
type MethodsMatch = [FeatureMethod] extends [keyof MethodKind]
  ? [keyof MethodKind] extends [FeatureMethod]
    ? true
    : never
  : never;
const methodsMatch: MethodsMatch = true;
void methodsMatch;

type RangeMatch = (typeof SERVER_MIN) extends HealthStatus["protocolMin"]
  ? (typeof SERVER_MAX) extends HealthStatus["protocolMax"]
    ? HealthStatus["protocolMin"] extends typeof SERVER_MIN
      ? HealthStatus["protocolMax"] extends typeof SERVER_MAX
        ? true
        : never
      : never
    : never
  : never;
const rangeMatch: RangeMatch = true;
void rangeMatch;

type ProtocolVersion = typeof SERVER_MIN | typeof SERVER_MAX;
type RejectReason = "bad-frame" | "unsupported" | "empty-prompt" | "unauthorized";
type RequestId = string & { readonly __brand: "RequestId" };
type RunId = string & { readonly __brand: "RunId" };
type DeviceToken = string & { readonly __brand: "DeviceToken" };
type Nonce = string & { readonly __brand: "Nonce" };

export type GatewayBindings = {
  readonly EVEN_G2_BRIDGE_URL?: string;
  readonly EVEN_G2_TOKEN?: string;
  readonly GATEWAY_TOKEN?: string;
  readonly ALLOW_ANY_TOKEN?: string;
};

export type GatewayConfig = {
  readonly bridgeUrl: string;
  readonly bridgeToken: string | null;
} & (
  | { readonly allowAnyToken: true; readonly gatewayToken: string | null }
  | { readonly allowAnyToken: false; readonly gatewayToken: string }
);

export type ParsedEnv =
  | { readonly ok: true; readonly config: GatewayConfig }
  | { readonly ok: false; readonly error: "missing-gateway-token" };

export type HttpRequest = {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
};

export type HttpResponse = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
};

export type SocketPort = {
  send(text: string): void;
  close(reason: string): void;
  onText(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
};

export type Served =
  | { readonly kind: "upgrade"; attach(socket: SocketPort): void }
  | { readonly kind: "respond"; readonly response: HttpResponse }
  | { readonly kind: "static" };

export type GatewayHost = {
  receive(request: HttpRequest): Promise<Served>;
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Stark-Persona",
} as const;

function blank(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseEnv(source: GatewayBindings): ParsedEnv {
  const allowAnyToken = source.ALLOW_ANY_TOKEN === "true";
  const gatewayToken = blank(source.GATEWAY_TOKEN);
  const bridgeUrl = (blank(source.EVEN_G2_BRIDGE_URL) ?? DEFAULT_BRIDGE).replace(/\/+$/, "");
  const bridgeToken = blank(source.EVEN_G2_TOKEN);
  if (!allowAnyToken) {
    if (gatewayToken === null) return { ok: false, error: "missing-gateway-token" };
    return { ok: true, config: { allowAnyToken: false, gatewayToken, bridgeUrl, bridgeToken } };
  }
  return { ok: true, config: { allowAnyToken: true, gatewayToken, bridgeUrl, bridgeToken } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRequestId(value: string): RequestId {
  return value as RequestId;
}

function asRunId(value: string): RunId {
  return value as RunId;
}

function asNonce(value: string): Nonce {
  return value as Nonce;
}

function deviceToken(bytes: Uint8Array): DeviceToken {
  if (bytes.byteLength !== 32) throw new Error("device token bytes");
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex as DeviceToken;
}

function offlineReply(outboundText: string): string {
  return OFFLINE_PREFIX + outboundText;
}

function localResult(personaId: PersonaId, outbound: string): Extract<ChatResult, { ok: true }> {
  return {
    ok: true,
    reply: offlineReply(outbound),
    model: LOCAL_MODEL,
    personaId,
    routedToGrokBot: false,
  };
}

function bridgeCompletionsUrl(bridgeUrl: string): string {
  return `${bridgeUrl.replace(/\/+$/, "")}/v1/chat/completions`;
}

function completionText(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.choices)) return null;
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") return null;
  return first.message.content;
}

function completionModel(value: unknown): string | null {
  if (!isRecord(value) || typeof value.model !== "string" || value.model.trim() === "") return null;
  return value.model;
}

function upstreamModel(model: string): UpstreamModel | null {
  if (model === LOCAL_MODEL) return null;
  return model as UpstreamModel;
}

async function completeChat(
  input: {
    readonly message: string;
    readonly personaId: PersonaId;
    readonly history: readonly ChatTurn[];
    readonly token: string | null;
  },
  config: GatewayConfig,
): Promise<Extract<ChatResult, { ok: true }>> {
  const outbound = plainUtterance(input.message);
  const bearer = input.token ?? config.bridgeToken;
  if (!bearer) return localResult(input.personaId, outbound);
  try {
    const response = await fetch(bridgeCompletionsUrl(config.bridgeUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({
        model: "grok",
        messages: [
          ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
          { role: "user", content: outbound },
        ],
      }),
    });
    if (!response.ok) return localResult(input.personaId, outbound);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return localResult(input.personaId, outbound);
    }
    const text = completionText(parsed);
    const modelName = completionModel(parsed);
    const model = modelName === null ? null : upstreamModel(modelName);
    if (text === null || model === null) return localResult(input.personaId, outbound);
    return { ok: true, reply: text, model, personaId: input.personaId, routedToGrokBot: true };
  } catch {
    return localResult(input.personaId, outbound);
  }
}

function negotiate(minProtocol: number, maxProtocol: number): ProtocolVersion | null {
  if (!Number.isInteger(minProtocol) || !Number.isInteger(maxProtocol)) return null;
  const low = Math.max(SERVER_MIN, minProtocol);
  const high = Math.min(SERVER_MAX, maxProtocol);
  if (low > high) return null;
  if (high === SERVER_MAX) return SERVER_MAX;
  if (high === SERVER_MIN) return SERVER_MIN;
  return null;
}

type LiveRun = {
  readonly runId: RunId;
  readonly sessionKey: string;
  readonly prompt: string;
  readonly personaId: PersonaId;
  readonly history: readonly ChatTurn[];
  readonly text: string;
  readonly phase: "open" | "final";
  readonly waiterId: RequestId | null;
};

type Session =
  | { readonly tag: "idle" }
  | { readonly tag: "challenged"; readonly nonce: Nonce; readonly atMs: number }
  | {
      readonly tag: "live";
      readonly protocol: ProtocolVersion;
      readonly deviceToken: DeviceToken;
      readonly connId: string;
      readonly issuedAtMs: number;
      readonly runs: ReadonlyMap<RequestId, LiveRun>;
      readonly turns: ReadonlyMap<string, readonly ChatTurn[]>;
      readonly ticksArmed: boolean;
      readonly lastTickMs: number;
    }
  | { readonly tag: "closed" };

type ClientRequest =
  | {
      readonly kind: "connect";
      readonly id: RequestId;
      readonly minProtocol: number;
      readonly maxProtocol: number;
      readonly token: string | null;
      readonly deviceToken: string | null;
    }
  | {
      readonly kind: "talk";
      readonly id: RequestId;
      readonly prompt: string;
      readonly sessionKey: string;
      readonly personaId: PersonaId;
      readonly history: readonly ChatTurn[];
    }
  | { readonly kind: "abort"; readonly id: RequestId; readonly runId: RunId }
  | { readonly kind: "subscribe"; readonly id: RequestId }
  | { readonly kind: "history"; readonly id: RequestId; readonly sessionKey: string }
  | { readonly kind: "wait"; readonly id: RequestId; readonly runId: RunId }
  | { readonly kind: "createTalk"; readonly id: RequestId }
  | { readonly kind: "reject"; readonly id: RequestId; readonly reason: RejectReason };

type ServerMessage =
  | { readonly kind: "challenge"; readonly nonce: Nonce; readonly ts: number }
  | {
      readonly kind: "hello";
      readonly id: RequestId;
      readonly protocol: ProtocolVersion;
      readonly connId: string;
      readonly deviceToken: DeviceToken;
      readonly issuedAtMs: number;
    }
  | { readonly kind: "ack"; readonly id: RequestId; readonly runId: RunId }
  | { readonly kind: "ok"; readonly id: RequestId }
  | {
      readonly kind: "history";
      readonly id: RequestId;
      readonly sessionKey: string;
      readonly messages: readonly ChatTurn[];
    }
  | { readonly kind: "wait"; readonly id: RequestId; readonly runId: RunId; readonly text: string }
  | { readonly kind: "talk"; readonly id: RequestId; readonly sessionKey: string }
  | { readonly kind: "reject"; readonly id: RequestId; readonly reason: RejectReason }
  | {
      readonly kind: "chat";
      readonly runId: RunId;
      readonly sessionKey: string;
      readonly state: "delta" | "final";
      readonly text: string;
      readonly seq: number;
      readonly timestamp: number;
    }
  | { readonly kind: "tick"; readonly ts: number }
  | { readonly kind: "heartbeat" };

type SessionEffect =
  | { readonly type: "send"; readonly message: ServerMessage }
  | {
      readonly type: "bridge";
      readonly requestId: RequestId;
      readonly prompt: string;
      readonly sessionKey: string;
      readonly personaId: PersonaId;
      readonly history: readonly ChatTurn[];
    }
  | { readonly type: "remember"; readonly token: DeviceToken }
  | { readonly type: "armTicks" }
  | { readonly type: "close"; readonly reason: "max-payload" };

type StepResult = {
  readonly state: Session;
  readonly effects: readonly SessionEffect[];
};

type StepInput =
  | { readonly type: "open"; readonly nowMs: number; readonly nonce: Nonce }
  | {
      readonly type: "request";
      readonly nowMs: number;
      readonly request: ClientRequest;
      readonly mintedDeviceToken: DeviceToken;
      readonly mintedRunId: RunId;
      readonly mintedConnId: string;
    }
  | { readonly type: "tick"; readonly nowMs: number }
  | {
      readonly type: "model";
      readonly requestId: RequestId;
      readonly fullText: string;
      readonly finish: boolean;
      readonly nowMs: number;
    }
  | { readonly type: "close" };

type TokenBook = {
  has(token: string): boolean;
  add(token: DeviceToken): void;
};

type StepContext = {
  readonly config: GatewayConfig;
  readonly book: TokenBook;
};

function serializeServerMessage(message: ServerMessage): string {
  switch (message.kind) {
    case "challenge":
      return JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: message.nonce, ts: message.ts },
      });
    case "hello":
      return JSON.stringify({
        type: "res",
        id: message.id,
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: message.protocol,
          server: { version: SERVER_VERSION, connId: message.connId },
          features: { methods: FEATURE_METHODS, events: FEATURE_EVENTS },
          snapshot: {},
          auth: {
            role: "node",
            scopes: [],
            deviceToken: message.deviceToken,
            issuedAtMs: message.issuedAtMs,
          },
          policy: {
            maxPayload: LIMITS.maxPayload,
            maxBufferedBytes: LIMITS.maxBufferedBytes,
            tickIntervalMs: LIMITS.tickIntervalMs,
          },
        },
      });
    case "ack":
      return JSON.stringify({
        type: "res",
        id: message.id,
        ok: true,
        payload: { ok: true, runId: message.runId },
      });
    case "ok":
      return JSON.stringify({ type: "res", id: message.id, ok: true, payload: { ok: true } });
    case "history":
      return JSON.stringify({
        type: "res",
        id: message.id,
        ok: true,
        payload: { ok: true, sessionKey: message.sessionKey, messages: message.messages },
      });
    case "wait":
      return JSON.stringify({
        type: "res",
        id: message.id,
        ok: true,
        payload: { ok: true, runId: message.runId, text: message.text },
      });
    case "talk":
      return JSON.stringify({
        type: "res",
        id: message.id,
        ok: true,
        payload: { ok: true, sessionKey: message.sessionKey },
      });
    case "reject":
      return JSON.stringify({
        type: "res",
        id: message.id,
        ok: false,
        error: { code: message.reason },
      });
    case "chat":
      return JSON.stringify({
        type: "event",
        event: "chat",
        seq: message.seq,
        payload: {
          runId: message.runId,
          sessionKey: message.sessionKey,
          seq: message.seq,
          state: message.state,
          message: {
            role: "assistant",
            content: [{ type: "text", text: message.text }],
            timestamp: message.timestamp,
          },
        },
      });
    case "tick":
      return JSON.stringify({ type: "event", event: "tick", payload: { ts: message.ts } });
    case "heartbeat":
      return JSON.stringify({ type: "event", event: "heartbeat", payload: {} });
    default: {
      const unreachable: never = message;
      return unreachable;
    }
  }
}

function isFeatureMethod(method: string): method is FeatureMethod {
  return (FEATURE_METHODS as readonly string[]).includes(method);
}

function readId(value: unknown): RequestId {
  return asRequestId(typeof value === "string" && value.length > 0 ? value : "bad");
}

function parseHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: ChatTurn[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if ((entry.role !== "user" && entry.role !== "assistant") || typeof entry.content !== "string") continue;
    turns.push({ role: entry.role, content: entry.content });
  }
  return turns;
}

function sessionKeyOf(params: Record<string, unknown>): string {
  return typeof params.sessionKey === "string" && params.sessionKey.trim() !== "" ? params.sessionKey : "main";
}

function parseClientFrame(raw: string): ClientRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: "reject", id: asRequestId("bad"), reason: "bad-frame" };
  }
  if (!isRecord(value) || value.type !== "req" || typeof value.method !== "string") {
    return { kind: "reject", id: readId(isRecord(value) ? value.id : "bad"), reason: "bad-frame" };
  }
  const id = readId(value.id);
  const params = isRecord(value.params) ? value.params : {};
  if (value.method === "connect") {
    if (typeof params.minProtocol !== "number" || typeof params.maxProtocol !== "number") {
      return { kind: "reject", id, reason: "bad-frame" };
    }
    const auth = isRecord(params.auth) ? params.auth : {};
    return {
      kind: "connect",
      id,
      minProtocol: params.minProtocol,
      maxProtocol: params.maxProtocol,
      token: typeof auth.token === "string" ? auth.token : null,
      deviceToken: typeof auth.deviceToken === "string" ? auth.deviceToken : null,
    };
  }
  if (!isFeatureMethod(value.method)) return { kind: "reject", id, reason: "unsupported" };
  const handler = HANDLERS[value.method];
  if (handler === "talk") {
    const prompt = params.message ?? params.prompt ?? params.text;
    if (typeof prompt !== "string" || prompt.trim() === "") return { kind: "reject", id, reason: "empty-prompt" };
    return {
      kind: "talk",
      id,
      prompt,
      sessionKey: sessionKeyOf(params),
      personaId: parsePersonaId(params.personaId),
      history: parseHistory(params.history),
    };
  }
  if (handler === "abort" || handler === "wait") {
    if (typeof params.runId !== "string" || params.runId.length === 0) {
      return { kind: "reject", id, reason: "bad-frame" };
    }
    return handler === "abort"
      ? { kind: "abort", id, runId: asRunId(params.runId) }
      : { kind: "wait", id, runId: asRunId(params.runId) };
  }
  if (handler === "history") return { kind: "history", id, sessionKey: sessionKeyOf(params) };
  if (handler === "subscribe") return { kind: "subscribe", id };
  return { kind: "createTalk", id };
}

function none(state: Session): StepResult {
  return { state, effects: [] };
}

function send(state: Session, message: ServerMessage): StepResult {
  return { state, effects: [{ type: "send", message }] };
}

function reject(state: Session, id: RequestId, reason: RejectReason): StepResult {
  return send(state, { kind: "reject", id, reason });
}

function chatMessage(run: LiveRun, state: "delta" | "final", text: string, seq: number, timestamp: number): ServerMessage {
  return { kind: "chat", runId: run.runId, sessionKey: run.sessionKey, state, text, seq, timestamp };
}

function helloFrom(session: Extract<Session, { tag: "live" }>, id: RequestId): ServerMessage {
  return {
    kind: "hello",
    id,
    protocol: session.protocol,
    connId: session.connId,
    deviceToken: session.deviceToken,
    issuedAtMs: session.issuedAtMs,
  };
}

function authorized(ctx: StepContext, token: string | null, presented: string | null): boolean {
  if (presented !== null && ctx.book.has(presented)) return true;
  if (ctx.config.allowAnyToken) return true;
  return token !== null && token === ctx.config.gatewayToken;
}

function findRun(session: Extract<Session, { tag: "live" }>, runId: RunId): [RequestId, LiveRun] | null {
  for (const [id, run] of session.runs) {
    if (run.runId === runId) return [id, run];
  }
  return null;
}

function onConnect(session: Session, input: Extract<StepInput, { type: "request" }>, request: Extract<ClientRequest, { kind: "connect" }>, ctx: StepContext): StepResult {
  if (session.tag === "live") return send(session, helloFrom(session, request.id));
  if (session.tag !== "challenged") return reject(session, request.id, "unauthorized");
  const protocol = negotiate(request.minProtocol, request.maxProtocol);
  if (protocol === null) return reject(session, request.id, "unsupported");
  if (!authorized(ctx, request.token, request.deviceToken)) return reject(session, request.id, "unauthorized");
  const live: Extract<Session, { tag: "live" }> = {
    tag: "live",
    protocol,
    deviceToken: input.mintedDeviceToken,
    connId: input.mintedConnId,
    issuedAtMs: input.nowMs,
    runs: new Map(),
    turns: new Map(),
    ticksArmed: true,
    lastTickMs: input.nowMs,
  };
  return {
    state: live,
    effects: [
      { type: "remember", token: input.mintedDeviceToken },
      { type: "armTicks" },
      { type: "send", message: helloFrom(live, request.id) },
    ],
  };
}

function onTalk(session: Extract<Session, { tag: "live" }>, input: Extract<StepInput, { type: "request" }>, request: Extract<ClientRequest, { kind: "talk" }>): StepResult {
  const existing = session.runs.get(request.id);
  if (existing) return send(session, { kind: "ack", id: request.id, runId: existing.runId });
  const history = request.history.length > 0 ? request.history : (session.turns.get(request.sessionKey) ?? []);
  const run: LiveRun = {
    runId: input.mintedRunId,
    sessionKey: request.sessionKey,
    prompt: request.prompt,
    personaId: request.personaId,
    history,
    text: "",
    phase: "open",
    waiterId: null,
  };
  const runs = new Map(session.runs);
  runs.set(request.id, run);
  return {
    state: { ...session, runs },
    effects: [
      { type: "send", message: { kind: "ack", id: request.id, runId: run.runId } },
      {
        type: "bridge",
        requestId: request.id,
        prompt: request.prompt,
        sessionKey: request.sessionKey,
        personaId: request.personaId,
        history,
      },
    ],
  };
}

function onModel(session: Session, input: Extract<StepInput, { type: "model" }>): StepResult {
  if (session.tag !== "live") return none(session);
  const run = session.runs.get(input.requestId);
  if (!run || run.phase === "final") return none(session);
  if (run.text !== "" && !input.fullText.startsWith(run.text)) return none(session);
  if (!input.finish) {
    const runs = new Map(session.runs);
    runs.set(input.requestId, { ...run, text: input.fullText });
    const effects: SessionEffect[] = [];
    if (input.fullText !== run.text) {
      effects.push({ type: "send", message: chatMessage(run, "delta", input.fullText, 0, input.nowMs) });
    }
    return { state: { ...session, runs }, effects };
  }
  const text = input.fullText;
  const runs = new Map(session.runs);
  runs.set(input.requestId, { ...run, text, phase: "final", waiterId: null });
  const prior = session.turns.get(run.sessionKey) ?? run.history;
  const last = prior.at(-1);
  const withUser =
    last?.role === "user" && last.content === run.prompt ? prior : [...prior, { role: "user" as const, content: run.prompt }];
  const turns = new Map(session.turns);
  turns.set(run.sessionKey, [...withUser, { role: "assistant", content: text }]);
  const effects: SessionEffect[] = [
    { type: "send", message: chatMessage(run, "delta", text, 0, input.nowMs) },
    { type: "send", message: chatMessage(run, "final", text, 1, input.nowMs) },
  ];
  if (run.waiterId) effects.push({ type: "send", message: { kind: "wait", id: run.waiterId, runId: run.runId, text } });
  return { state: { ...session, runs, turns }, effects };
}

function step(session: Session, input: StepInput, ctx: StepContext): StepResult {
  switch (input.type) {
    case "open":
      return {
        state: { tag: "challenged", nonce: input.nonce, atMs: input.nowMs },
        effects: [{ type: "send", message: { kind: "challenge", nonce: input.nonce, ts: input.nowMs } }],
      };
    case "close":
      return { state: { tag: "closed" }, effects: [] };
    case "tick": {
      if (session.tag !== "live") return none(session);
      if (input.nowMs - session.lastTickMs < LIMITS.tickIntervalMs - TICK_SLACK_MS) return none(session);
      return {
        state: { ...session, lastTickMs: input.nowMs },
        effects: [
          { type: "send", message: { kind: "tick", ts: input.nowMs } },
          { type: "send", message: { kind: "heartbeat" } },
        ],
      };
    }
    case "model":
      return onModel(session, input);
    case "request": {
      const request = input.request;
      if (request.kind === "reject") return reject(session, request.id, request.reason);
      if (request.kind === "connect") return onConnect(session, input, request, ctx);
      if (session.tag !== "live") return reject(session, request.id, "unauthorized");
      switch (request.kind) {
        case "talk":
          return onTalk(session, input, request);
        case "abort": {
          const found = findRun(session, request.runId);
          if (!found || found[1].phase === "final") return send(session, { kind: "ok", id: request.id });
          const [runRequestId, run] = found;
          const runs = new Map(session.runs);
          runs.set(runRequestId, { ...run, phase: "final" });
          return {
            state: { ...session, runs },
            effects: [
              { type: "send", message: { kind: "ok", id: request.id } },
              { type: "send", message: chatMessage(run, "final", run.text, 1, input.nowMs) },
            ],
          };
        }
        case "subscribe":
          return send(session, { kind: "ok", id: request.id });
        case "history":
          return send(session, {
            kind: "history",
            id: request.id,
            sessionKey: request.sessionKey,
            messages: session.turns.get(request.sessionKey) ?? [],
          });
        case "wait": {
          const found = findRun(session, request.runId);
          if (!found) return reject(session, request.id, "bad-frame");
          const [runRequestId, run] = found;
          if (run.phase === "final") {
            return send(session, { kind: "wait", id: request.id, runId: run.runId, text: run.text });
          }
          const runs = new Map(session.runs);
          runs.set(runRequestId, { ...run, waiterId: request.id });
          return { state: { ...session, runs }, effects: [] };
        }
        case "createTalk":
          return send(session, { kind: "talk", id: request.id, sessionKey: `talk-${input.mintedRunId}` });
        default: {
          const unreachable: never = request;
          return unreachable;
        }
      }
    }
    default: {
      const unreachable: never = input;
      return unreachable;
    }
  }
}

function acceptText(session: Session, raw: string, ctx: StepContext, nowMs: number): StepResult {
  if (new TextEncoder().encode(raw).byteLength > LIMITS.maxPayload) {
    return { state: { tag: "closed" }, effects: [{ type: "close", reason: "max-payload" }] };
  }
  return step(
    session,
    {
      type: "request",
      nowMs,
      request: parseClientFrame(raw),
      mintedDeviceToken: deviceToken(crypto.getRandomValues(new Uint8Array(32))),
      mintedRunId: asRunId(crypto.randomUUID()),
      mintedConnId: crypto.randomUUID(),
    },
    ctx,
  );
}

function bearerFrom(bodyToken: unknown, authorization: string | undefined): string | null {
  if (typeof bodyToken === "string" && bodyToken.trim() !== "") return bodyToken.trim();
  const match = /^Bearer\s+(\S+)/i.exec(authorization ?? "");
  return match?.[1] ?? null;
}

function readContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
  }
  return parts.length > 0 ? parts.join("") : null;
}

type ParsedChat = {
  readonly message: string;
  readonly personaId: PersonaId;
  readonly history: readonly ChatTurn[];
  readonly token: string | null;
};

function parseApiChat(request: HttpRequest): ParsedChat | null {
  let value: unknown;
  try {
    value = request.body === null || request.body.trim() === "" ? null : JSON.parse(request.body);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.message !== "string") return null;
  return {
    message: value.message,
    personaId: parsePersonaId(value.personaId ?? request.headers["x-stark-persona"]),
    history: parseHistory(value.history),
    token: bearerFrom(value.token, request.headers.authorization),
  };
}

function parseCompletions(request: HttpRequest): ParsedChat | null {
  let value: unknown;
  try {
    value = request.body === null ? null : JSON.parse(request.body);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.messages)) return null;
  const turns: ChatTurn[] = [];
  for (const entry of value.messages) {
    if (!isRecord(entry)) continue;
    const content = readContent(entry.content);
    if (content === null) continue;
    if (entry.role === "user" || entry.role === "assistant") turns.push({ role: entry.role, content });
  }
  let lastUser = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  const message = turns[lastUser]?.content;
  if (lastUser < 0 || message === undefined) return null;
  return {
    message,
    personaId: parsePersonaId(value.personaId ?? request.headers["x-stark-persona"]),
    history: turns.slice(0, lastUser),
    token: bearerFrom(value.token, request.headers.authorization),
  };
}

function jsonResponse(status: number, body: unknown, cors: boolean): HttpResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(cors ? CORS_HEADERS : {}),
    },
    body: JSON.stringify(body),
  };
}

function chatPayload(result: Extract<ChatResult, { ok: true }>): unknown {
  return {
    ok: true,
    reply: result.reply,
    model: result.model,
    personaId: result.personaId,
    routedToGrokBot: result.routedToGrokBot,
  };
}

function openAiPayload(result: Extract<ChatResult, { ok: true }>): unknown {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    choices: [{ index: 0, message: { role: "assistant", content: result.reply }, finish_reason: "stop" }],
  };
}

function badRequest(): HttpResponse {
  return jsonResponse(400, { ok: false, error: "bad-request" }, true);
}

function startInterval(fire: () => void): () => void {
  const handle = setInterval(fire, LIMITS.tickIntervalMs);
  if (typeof handle === "object" && handle !== null && "unref" in handle) handle.unref();
  return () => clearInterval(handle);
}

function attachSocket(socket: SocketPort, config: GatewayConfig, book: TokenBook): void {
  const ctx: StepContext = { config, book };
  let session: Session = { tag: "idle" };
  let cancelTicks: (() => void) | null = null;
  const apply = (result: StepResult): void => {
    session = result.state;
    for (const effect of result.effects) {
      switch (effect.type) {
        case "send":
          try {
            socket.send(serializeServerMessage(effect.message));
          } catch {
            session = { tag: "closed" };
          }
          break;
        case "remember":
          book.add(effect.token);
          break;
        case "armTicks":
          if (cancelTicks) break;
          cancelTicks = startInterval(() => {
            if (session.tag !== "live") return;
            apply(step(session, { type: "tick", nowMs: Date.now() }, ctx));
          });
          break;
        case "bridge":
          void completeChat(
            {
              message: effect.prompt,
              personaId: effect.personaId,
              history: effect.history,
              token: null,
            },
            config,
          ).then((chat) => {
            if (session.tag === "closed") return;
            apply(step(session, { type: "model", requestId: effect.requestId, fullText: chat.reply, finish: true, nowMs: Date.now() }, ctx));
          });
          break;
        case "close":
          cancelTicks?.();
          socket.close(effect.reason);
          break;
        default: {
          const unreachable: never = effect;
          return unreachable;
        }
      }
    }
  };

  let ready = false;
  const buffered: string[] = [];
  socket.onText((text) => {
    if (!ready) {
      buffered.push(text);
      return;
    }
    apply(acceptText(session, text, ctx, Date.now()));
  });
  socket.onClose(() => {
    cancelTicks?.();
    cancelTicks = null;
    session = { tag: "closed" };
  });
  apply(step(session, { type: "open", nowMs: Date.now(), nonce: asNonce(crypto.randomUUID()) }, ctx));
  ready = true;
  for (const text of buffered.splice(0)) apply(acceptText(session, text, ctx, Date.now()));
}

function createBook(): TokenBook {
  const tokens = new Set<string>();
  return {
    has(token) {
      return tokens.has(token);
    },
    add(token) {
      tokens.add(token);
    },
  };
}

const CHAT_PATHS = new Set(["/api/chat", "/v1/chat/completions"]);

export function startGateway(config: GatewayConfig): GatewayHost {
  const book = createBook();
  return {
    async receive(request) {
      const method = request.method.toUpperCase();
      const headers = request.headers;
      if (method === "OPTIONS" && CHAT_PATHS.has(request.path)) {
        return { kind: "respond", response: { status: 204, headers: CORS_HEADERS, body: null } };
      }
      if (method === "GET" && request.path === "/health") {
        return {
          kind: "respond",
          response: jsonResponse(
            200,
            { ok: true, service: "stark-r1-openclaw", protocolMin: SERVER_MIN, protocolMax: SERVER_MAX },
            false,
          ),
        };
      }
      if (method === "POST" && request.path === "/api/chat") {
        const parsed = parseApiChat(request);
        if (!parsed) return { kind: "respond", response: badRequest() };
        const result = await completeChat(parsed, config);
        return { kind: "respond", response: jsonResponse(200, chatPayload(result), true) };
      }
      if (method === "POST" && request.path === "/v1/chat/completions") {
        const parsed = parseCompletions(request);
        if (!parsed) return { kind: "respond", response: badRequest() };
        const result = await completeChat(parsed, config);
        return { kind: "respond", response: jsonResponse(200, openAiPayload(result), true) };
      }
      if (request.path === "/openclaw/ws") {
        if ((headers.upgrade ?? "").toLowerCase() === "websocket") {
          return { kind: "upgrade", attach: (socket) => attachSocket(socket, config, book) };
        }
        return {
          kind: "respond",
          response: { status: 426, headers: { "content-type": "text/plain; charset=utf-8" }, body: "upgrade required" },
        };
      }
      return { kind: "static" };
    },
  };
}
