import { FRAME_COLOR } from "./domain";

export const QR_RENDER = {
  errorCorrectionLevel: "L",
  margin: 4,
  color: { dark: "#000000", light: "#FFFFFF" },
} as const;

export const WSS_PORT = 443 as const;
export const LAN_PORT = 18789 as const;

const CREATION_TITLE = "Stark R1" as const;
export const CREATION_URL_VERSION = "20261029-elstt" as const;
const CREATION_DESCRIPTION = "F.R.I.D.A.Y. & Grok Bot Communicator for Rabbit R1" as const;
const QR_BYTE_LIMIT = 2900;

export type CreationQr = {
  readonly title: typeof CREATION_TITLE;
  readonly url: string;
  readonly description: typeof CREATION_DESCRIPTION;
  readonly iconUrl: string;
  readonly themeColor: typeof FRAME_COLOR;
};

export type OpenClawQr =
  | {
      readonly type: "clawdbot-gateway";
      readonly version: 1;
      readonly ips: readonly [string];
      readonly port: typeof WSS_PORT;
      readonly token: string;
      readonly protocol: "wss";
    }
  | {
      readonly type: "clawdbot-gateway";
      readonly version: 1;
      readonly ips: readonly [string];
      readonly port: typeof LAN_PORT;
      readonly token: string;
      readonly protocol: "ws";
    };

export type BuiltQr<T> =
  | { readonly ok: true; readonly value: T; readonly text: string }
  | { readonly ok: false; readonly reason: "too-long"; readonly bytes: number };

export type QrCheck = { readonly ok: true } | { readonly ok: false; readonly reason: "json" | "shape" | "too-long" };

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function finish<T>(value: T): BuiltQr<T> {
  const text = JSON.stringify(value);
  const bytes = utf8Length(text);
  if (bytes >= QR_BYTE_LIMIT) return { ok: false, reason: "too-long", bytes };
  return { ok: true, value, text };
}

function originBase(origin: string): string {
  return origin.replace(/\/+$/, "");
}

export function creationQr(origin: string): BuiltQr<CreationQr> {
  const base = originBase(origin);
  return finish({
    title: CREATION_TITLE,
    url: `${base}/?v=${CREATION_URL_VERSION}`,
    description: CREATION_DESCRIPTION,
    iconUrl: `${base}/icon.png`,
    themeColor: FRAME_COLOR,
  });
}

export function openClawWss(host: string, token: string): BuiltQr<Extract<OpenClawQr, { protocol: "wss" }>> {
  return finish({
    type: "clawdbot-gateway" as const,
    version: 1 as const,
    ips: [host] as const,
    port: WSS_PORT,
    token,
    protocol: "wss" as const,
  });
}

export function openClawLan(host: string, token: string): BuiltQr<Extract<OpenClawQr, { protocol: "ws" }>> {
  return finish({
    type: "clawdbot-gateway" as const,
    version: 1 as const,
    ips: [host] as const,
    port: LAN_PORT,
    token,
    protocol: "ws" as const,
  });
}

export function openClawForLocation(
  location: { readonly protocol: string; readonly hostname: string },
  token: string,
): BuiltQr<OpenClawQr> {
  if (location.protocol === "https:") return openClawWss(location.hostname, token);
  return openClawLan(location.hostname, token);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function creationInstall(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") return null;
  if (parsed.pathname !== "/" || parsed.search !== `?v=${CREATION_URL_VERSION}`) return null;
  return parsed.origin;
}

export function validateCreation(text: string): QrCheck {
  if (utf8Length(text) >= QR_BYTE_LIMIT) return { ok: false, reason: "too-long" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "json" };
  }
  if (!isRecord(value)) return { ok: false, reason: "shape" };
  if (Object.keys(value).length !== 5) return { ok: false, reason: "shape" };
  if (value.title !== CREATION_TITLE) return { ok: false, reason: "shape" };
  if (value.description !== CREATION_DESCRIPTION) return { ok: false, reason: "shape" };
  if (value.themeColor !== FRAME_COLOR) return { ok: false, reason: "shape" };
  if (typeof value.url !== "string" || typeof value.iconUrl !== "string") return { ok: false, reason: "shape" };
  const install = creationInstall(value.url);
  if (!install) return { ok: false, reason: "shape" };
  if (value.iconUrl !== `${install}/icon.png`) return { ok: false, reason: "shape" };
  return { ok: true };
}

export function validateOpenClaw(text: string): QrCheck {
  if (utf8Length(text) >= QR_BYTE_LIMIT) return { ok: false, reason: "too-long" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "json" };
  }
  if (!isRecord(value)) return { ok: false, reason: "shape" };
  if (Object.keys(value).length !== 6) return { ok: false, reason: "shape" };
  if (value.type !== "clawdbot-gateway" || value.version !== 1) return { ok: false, reason: "shape" };
  if (!Array.isArray(value.ips) || value.ips.length !== 1 || typeof value.ips[0] !== "string") {
    return { ok: false, reason: "shape" };
  }
  if (typeof value.token !== "string") return { ok: false, reason: "shape" };
  const wss = value.protocol === "wss" && value.port === WSS_PORT;
  const lan = value.protocol === "ws" && value.port === LAN_PORT;
  if (!wss && !lan) return { ok: false, reason: "shape" };
  return { ok: true };
}

const QR_DRAW = {
  ...QR_RENDER,
  width: 280,
} as const;

export async function renderPng(text: string): Promise<Uint8Array> {
  const { default: QRCode } = await import("qrcode");
  const buffer = await QRCode.toBuffer(text, QR_DRAW);
  return Uint8Array.from(buffer);
}

export async function renderDataUrl(text: string): Promise<string> {
  const { default: QRCode } = await import("qrcode");
  return QRCode.toDataURL(text, QR_DRAW);
}
