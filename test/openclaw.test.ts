import { afterEach, describe, expect, it } from "vitest";
import { startGateway, type GatewayConfig } from "../src/gateway";
import { listenGateway } from "../src/node-listen";

const METHODS = [
  "chat.send",
  "chat.abort",
  "chat.subscribe",
  "chat.history",
  "agent",
  "sessions.send",
  "agent.wait",
  "talk.session.create",
];

const EVENTS = ["chat", "agent", "tick", "heartbeat"];
const OFFLINE = "F.R.I.D.A.Y. is offline. Heard: Status check";

const offlineConfig: GatewayConfig = {
  allowAnyToken: true,
  gatewayToken: null,
  bridgeToken: null,
  bridgeUrl: "https://even-g2-bridge.saviormike.workers.dev",
};

type Frame = Record<string, unknown>;

function asRecord(value: unknown): Frame | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Frame;
}

function openSocket(url: string): Promise<{ ws: WebSocket; frames: unknown[] }> {
  const ws = new WebSocket(url);
  const frames: unknown[] = [];
  ws.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)));
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ ws, frames }));
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
}

async function until(pred: () => boolean): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > 3_000) throw new Error("timed out waiting for a socket frame");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function payloadOf(frame: unknown): Frame {
  const record = asRecord(frame);
  const payload = record ? asRecord(record.payload) : null;
  if (!payload) throw new Error("missing payload");
  return payload;
}

describe("OpenClaw socket", () => {
  const servers: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });

  it("challenges, negotiates protocol 3, then emits one delta and one final", async () => {
    const server = await listenGateway(startGateway(offlineConfig), { port: 0, staticDir: "dist" });
    servers.push(server);
    const { ws, frames } = await openSocket(server.url.replace("http", "ws") + "/openclaw/ws");
    try {
      await until(() => frames.length >= 1);
      const challenge = asRecord(frames[0]);
      expect(challenge).toMatchObject({ type: "event", event: "connect.challenge" });
      const challengePayload = payloadOf(frames[0]);
      expect(typeof challengePayload.nonce).toBe("string");
      expect(String(challengePayload.nonce).length).toBeGreaterThan(0);
      expect(typeof challengePayload.ts).toBe("number");

      ws.send(
        JSON.stringify({
          type: "req",
          id: "connect-1",
          method: "connect",
          params: { minProtocol: 3, maxProtocol: 3, auth: { token: "ignored" } },
        }),
      );
      await until(() => frames.some((frame) => asRecord(frame)?.id === "connect-1"));
      const hello = frames.find((frame) => asRecord(frame)?.id === "connect-1");
      const helloPayload = payloadOf(hello);
      expect(asRecord(hello)).toMatchObject({ type: "res", id: "connect-1", ok: true });
      expect(helloPayload.type).toBe("hello-ok");
      expect(helloPayload.protocol).toBe(3);
      expect(helloPayload.server).toMatchObject({ version: "stark-r1-openclaw/1.0.0" });
      expect(typeof asRecord(helloPayload.server)?.connId).toBe("string");
      expect(helloPayload.features).toMatchObject({ methods: METHODS, events: EVENTS });
      expect(helloPayload.snapshot).toEqual({});
      const auth = asRecord(helloPayload.auth);
      expect(auth).toMatchObject({ role: "node", scopes: [] });
      expect(auth?.deviceToken).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof auth?.issuedAtMs).toBe("number");
      expect(helloPayload.policy).toEqual({ maxPayload: 1048576, maxBufferedBytes: 4194304, tickIntervalMs: 15000 });

      ws.send(
        JSON.stringify({
          type: "req",
          id: "chat-1",
          method: "chat.send",
          params: { message: "Status check", sessionKey: "main" },
        }),
      );
      await until(() => chatFrames(frames).length >= 2);
      const ack = frames.find((frame) => asRecord(frame)?.id === "chat-1");
      const ackPayload = payloadOf(ack);
      expect(asRecord(ack)).toMatchObject({ type: "res", id: "chat-1", ok: true });
      expect(ackPayload.ok).toBe(true);
      expect(typeof ackPayload.runId).toBe("string");
      const chats = chatFrames(frames);
      expect(chats.map((frame) => payloadOf(frame).state)).toEqual(["delta", "final"]);
      expect(chats.map((frame) => asRecord(frame)?.seq)).toEqual([0, 1]);
      expect(chats.map((frame) => textOf(frame))).toEqual([OFFLINE, OFFLINE]);
      expect(payloadOf(chats[0]).runId).toBe(ackPayload.runId);
      expect(payloadOf(chats[1]).message).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: OFFLINE }],
      });
      expect(typeof asRecord(payloadOf(chats[1]).message)?.timestamp).toBe("number");

      const before = chatFrames(frames).length;
      ws.send(
        JSON.stringify({
          type: "req",
          id: "chat-1",
          method: "chat.send",
          params: { message: "Status check", sessionKey: "main" },
        }),
      );
      await until(() => frames.filter((frame) => asRecord(frame)?.id === "chat-1").length >= 2);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(chatFrames(frames).length).toBe(before);
      const acks = frames.filter((frame) => asRecord(frame)?.id === "chat-1");
      expect(acks).toHaveLength(2);
      expect(payloadOf(acks[1]).runId).toBe(ackPayload.runId);
      expect(textOf(chats[1])).toBe(OFFLINE);
    } finally {
      ws.close();
    }
  });

  it("rejects a range with no overlap and still accepts a later protocol 3 connect", async () => {
    const server = await listenGateway(startGateway(offlineConfig), { port: 0, staticDir: "dist" });
    servers.push(server);
    const { ws, frames } = await openSocket(server.url.replace("http", "ws") + "/openclaw/ws");
    try {
      await until(() => frames.length >= 1);
      ws.send(
        JSON.stringify({
          type: "req",
          id: "high",
          method: "connect",
          params: { minProtocol: 5, maxProtocol: 6 },
        }),
      );
      await until(() => frames.some((frame) => asRecord(frame)?.id === "high"));
      expect(asRecord(frames.find((frame) => asRecord(frame)?.id === "high"))).toMatchObject({ ok: false });
      ws.send(
        JSON.stringify({
          type: "req",
          id: "chat-early",
          method: "chat.send",
          params: { message: "too soon" },
        }),
      );
      await until(() => frames.some((frame) => asRecord(frame)?.id === "chat-early"));
      expect(asRecord(frames.find((frame) => asRecord(frame)?.id === "chat-early"))?.ok).toBe(false);
      expect(chatFrames(frames)).toHaveLength(0);
      ws.send(
        JSON.stringify({
          type: "req",
          id: "ok",
          method: "connect",
          params: { minProtocol: 3, maxProtocol: 4, auth: { token: "x" } },
        }),
      );
      await until(() => frames.some((frame) => asRecord(frame)?.id === "ok"));
      expect(payloadOf(frames.find((frame) => asRecord(frame)?.id === "ok")).protocol).toBe(4);
    } finally {
      ws.close();
    }
  });

  it("lets a device token in the book reconnect without the gateway token", async () => {
    const server = await listenGateway(
      startGateway({
        allowAnyToken: false,
        gatewayToken: "gateway-secret",
        bridgeToken: null,
        bridgeUrl: "https://even-g2-bridge.saviormike.workers.dev",
      }),
      { port: 0, staticDir: "dist" },
    );
    servers.push(server);
    const url = server.url.replace("http", "ws") + "/openclaw/ws";
    const first = await openSocket(url);
    try {
      await until(() => first.frames.length >= 1);
      first.ws.send(
        JSON.stringify({
          type: "req",
          id: "c1",
          method: "connect",
          params: { minProtocol: 3, maxProtocol: 3, auth: { token: "gateway-secret" } },
        }),
      );
      await until(() => first.frames.some((frame) => asRecord(frame)?.id === "c1"));
      const deviceToken = asRecord(payloadOf(first.frames.find((frame) => asRecord(frame)?.id === "c1")).auth)?.deviceToken;
      expect(deviceToken).toMatch(/^[0-9a-f]{64}$/);
      first.ws.close();

      const second = await openSocket(url);
      await until(() => second.frames.length >= 1);
      second.ws.send(
        JSON.stringify({
          type: "req",
          id: "c2",
          method: "connect",
          params: { minProtocol: 3, maxProtocol: 3, auth: { token: "wrong", deviceToken } },
        }),
      );
      await until(() => second.frames.some((frame) => asRecord(frame)?.id === "c2"));
      expect(payloadOf(second.frames.find((frame) => asRecord(frame)?.id === "c2")).type).toBe("hello-ok");
      second.ws.close();

      const third = await openSocket(url);
      await until(() => third.frames.length >= 1);
      third.ws.send(
        JSON.stringify({
          type: "req",
          id: "c3",
          method: "connect",
          params: { minProtocol: 3, maxProtocol: 3, auth: { token: "wrong" } },
        }),
      );
      await until(() => third.frames.some((frame) => asRecord(frame)?.id === "c3"));
      expect(asRecord(third.frames.find((frame) => asRecord(frame)?.id === "c3"))?.ok).toBe(false);
      third.ws.close();
    } finally {
      first.ws.close();
    }
  });
});

function chatFrames(frames: unknown[]): unknown[] {
  return frames.filter((frame) => asRecord(frame)?.event === "chat");
}

function textOf(frame: unknown): string {
  const message = asRecord(payloadOf(frame).message);
  const content = message?.content;
  const first = Array.isArray(content) ? asRecord(content[0]) : null;
  return typeof first?.text === "string" ? first.text : "";
}
