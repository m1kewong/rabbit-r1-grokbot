import { describe, expect, it } from "vitest";
import { FRAME_COLOR } from "../src/domain";
import {
  creationQr,
  LAN_PORT,
  openClawForLocation,
  openClawLan,
  openClawWss,
  renderPng,
  validateCreation,
  validateOpenClaw,
  WSS_PORT,
} from "../src/qr";
import { qrCardTokens } from "../scripts/generate-qr";

const PAIR_TOKEN = "paired/token+for stark-r1 gateway secret!!123456";

const CREATION = {
  title: "Stark R1",
  url: "https://r1.example/?v=20261031-pair",
  description: "F.R.I.D.A.Y. & Grok Bot Communicator for Rabbit R1",
  iconUrl: "https://r1.example/icon.png",
  themeColor: FRAME_COLOR,
};

describe("creation QR", () => {
  it("writes the Stark creation payload and strips a trailing slash", () => {
    const built = creationQr("https://r1.example/");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(JSON.parse(built.text)).toEqual(CREATION);
    expect(validateCreation(built.text)).toEqual({ ok: true });
    const stripped = creationQr("https://r1.example");
    expect(stripped.ok).toBe(true);
    if (stripped.ok) expect(stripped.text).toBe(built.text);
  });

  it("cache-busts the creation install url and points the icon at a png", () => {
    const built = creationQr("https://r1.example");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const url = new URL(built.value.url);
    expect(`${url.origin}${url.pathname}`).toBe("https://r1.example/");
    expect(url.search).toBe("?v=20261031-pair");
    expect(built.value.iconUrl).toBe("https://r1.example/icon.png");
    expect(validateCreation(built.text)).toEqual({ ok: true });
  });

  it("rejects a payload of 2900 bytes or more", () => {
    expect(validateCreation("x".repeat(2900))).toEqual({ ok: false, reason: "too-long" });
    expect(validateCreation("x".repeat(2901))).toEqual({ ok: false, reason: "too-long" });
    const huge = creationQr(`https://${"a".repeat(2900)}.example`);
    expect(huge.ok).toBe(false);
    if (huge.ok) return;
    expect(huge.reason).toBe("too-long");
    expect(huge.bytes).toBeGreaterThanOrEqual(2900);
  });

  it("rejects a creation payload whose shape drifted", () => {
    expect(validateCreation("{")).toEqual({ ok: false, reason: "json" });
    const drifted = { ...CREATION, themeColor: "#000000" };
    expect(validateCreation(JSON.stringify(drifted))).toEqual({ ok: false, reason: "shape" });
    const stale = { ...CREATION, url: "https://r1.example/" };
    expect(validateCreation(JSON.stringify(stale))).toEqual({ ok: false, reason: "shape" });
  });

  it("stays version-only when the token is omitted or blank", () => {
    for (const built of [creationQr("https://r1.example"), creationQr("https://r1.example", "  ")]) {
      expect(built.ok).toBe(true);
      if (!built.ok) return;
      expect(Object.keys(JSON.parse(built.text)).sort()).toEqual([
        "description",
        "iconUrl",
        "themeColor",
        "title",
        "url",
      ]);
      expect(new URL(built.value.url).search).toBe("?v=20261031-pair");
      expect(validateCreation(built.text)).toEqual({ ok: true });
    }
  });

  it("embeds a paired gateway token in the creation url", () => {
    expect(PAIR_TOKEN).toHaveLength(48);
    const built = creationQr("https://r1.example", PAIR_TOKEN);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.url).toBe(`https://r1.example/?v=20261031-pair&t=${encodeURIComponent(PAIR_TOKEN)}`);
    expect(validateCreation(built.text)).toEqual({ ok: true });
    expect(new TextEncoder().encode(built.text).byteLength).toBeLessThan(2900);
  });

  it("trims one gateway token for both printed cards", () => {
    const cards = qrCardTokens(`  ${PAIR_TOKEN}  `);
    expect(cards).toEqual({ creation: PAIR_TOKEN, openClaw: PAIR_TOKEN });
    expect(qrCardTokens(undefined)).toEqual({ creation: undefined, openClaw: "dev-token" });
    expect(qrCardTokens("   ")).toEqual({ creation: undefined, openClaw: "dev-token" });
    const built = creationQr("https://r1.example", cards.creation);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.url).toContain(encodeURIComponent(PAIR_TOKEN));
  });

  it("rejects an install url that is not the version and optional token", () => {
    const payload = (url: string): string => JSON.stringify({ ...CREATION, url });
    expect(validateCreation(payload("https://r1.example/?v=20261031-pair&t="))).toEqual({
      ok: false,
      reason: "shape",
    });
    expect(validateCreation(payload("https://r1.example/?v=20261031-pair&t=%20"))).toEqual({
      ok: false,
      reason: "shape",
    });
    expect(validateCreation(payload("https://r1.example/?v=20261030-hud"))).toEqual({ ok: false, reason: "shape" });
    expect(validateCreation(payload("https://r1.example/?v=20261031-pair&extra=1"))).toEqual({
      ok: false,
      reason: "shape",
    });
    expect(validateCreation(payload("https://user:secret@r1.example/?v=20261031-pair"))).toEqual({
      ok: false,
      reason: "shape",
    });
    expect(validateCreation(payload("https://r1.example/?v=20261031-pair#x"))).toEqual({ ok: false, reason: "shape" });
    expect(validateCreation(payload("https://r1.example/app?v=20261031-pair"))).toEqual({ ok: false, reason: "shape" });
    expect(validateCreation(payload("https://r1.example/?v=20261031-pair&v=20261031-pair"))).toEqual({
      ok: false,
      reason: "shape",
    });
    expect(validateCreation(payload("not a url"))).toEqual({ ok: false, reason: "shape" });
    expect(validateCreation(payload("https://r1.example/?t=ok&v=20261031-pair"))).toEqual({ ok: true });
  });
});

describe("QR png", () => {
  it("renders a PNG", async () => {
    const built = creationQr("https://r1.example");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const png = await renderPng(built.text);
    expect(Buffer.from(png.subarray(0, 8)).toString("hex")).toBe("89504e470d0a1a0a");
  });
});

describe("OpenClaw QR", () => {
  it("pairs wss with 443 and ws with 18789", () => {
    const wss = openClawWss("gw.example", "tok");
    const lan = openClawLan("192.168.1.8", "tok");
    expect(wss.ok).toBe(true);
    expect(lan.ok).toBe(true);
    if (!wss.ok || !lan.ok) return;
    expect(JSON.parse(wss.text)).toEqual({
      type: "clawdbot-gateway",
      version: 1,
      ips: ["gw.example"],
      port: WSS_PORT,
      token: "tok",
      protocol: "wss",
    });
    expect(JSON.parse(lan.text)).toEqual({
      type: "clawdbot-gateway",
      version: 1,
      ips: ["192.168.1.8"],
      port: LAN_PORT,
      token: "tok",
      protocol: "ws",
    });
    expect(validateOpenClaw(wss.text)).toEqual({ ok: true });
    expect(validateOpenClaw(lan.text)).toEqual({ ok: true });
    const secure = openClawForLocation({ protocol: "https:", hostname: "gw.example" }, "tok");
    const plain = openClawForLocation({ protocol: "http:", hostname: "192.168.1.8" }, "tok");
    expect(secure.ok).toBe(true);
    expect(plain.ok).toBe(true);
    if (secure.ok) expect(secure.text).toBe(wss.text);
    if (plain.ok) expect(plain.text).toBe(lan.text);
  });

  it("rejects a port and protocol pair that is not in the union", () => {
    const swapped = {
      type: "clawdbot-gateway",
      version: 1,
      ips: ["gw.example"],
      port: LAN_PORT,
      token: "tok",
      protocol: "wss",
    };
    const other = { ...swapped, port: WSS_PORT, protocol: "ws" };
    expect(validateOpenClaw(JSON.stringify(swapped))).toEqual({ ok: false, reason: "shape" });
    expect(validateOpenClaw(JSON.stringify(other))).toEqual({ ok: false, reason: "shape" });
    expect(validateOpenClaw("x".repeat(2900))).toEqual({ ok: false, reason: "too-long" });
  });
});
