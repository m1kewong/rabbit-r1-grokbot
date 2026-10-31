import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import type { GatewayBindings } from "../src/gateway";
import { creationQr, openClawWss, renderPng } from "../src/qr";

const NAMES = ["r1-creation-qr.png", "r1-openclaw-wss-qr.png", "r1-dual-qr-card.png"] as const;
const DIRS = ["artifacts", "/opt/cursor/artifacts"] as const;

const GLYPHS: Record<string, number[]> = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  I: [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  O: [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b01010, 0b01010],
};

function setPixel(png: PNG, x: number, y: number, rgba: readonly [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const index = (y * png.width + x) * 4;
  png.data[index] = rgba[0];
  png.data[index + 1] = rgba[1];
  png.data[index + 2] = rgba[2];
  png.data[index + 3] = rgba[3];
}

function inRound(px: number, py: number, x: number, y: number, w: number, h: number, radius: number): boolean {
  if (px < x || py < y || px >= x + w || py >= y + h) return false;
  const left = px < x + radius;
  const right = px >= x + w - radius;
  const top = py < y + radius;
  const bottom = py >= y + h - radius;
  if (!(left || right) || !(top || bottom)) return true;
  const cx = left ? x + radius : x + w - radius;
  const cy = top ? y + radius : y + h - radius;
  const dx = px + 0.5 - cx;
  const dy = py + 0.5 - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function strokeRound(
  png: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  width: number,
  color: readonly [number, number, number, number],
): void {
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      if (!inRound(px, py, x, y, w, h, radius)) continue;
      if (inRound(px, py, x + width, y + width, w - width * 2, h - width * 2, Math.max(0, radius - width))) continue;
      setPixel(png, px, py, color);
    }
  }
}

function blit(dest: PNG, src: PNG, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y += 1) {
    for (let x = 0; x < src.width; x += 1) {
      const from = (y * src.width + x) * 4;
      const to = ((dy + y) * dest.width + (dx + x)) * 4;
      dest.data[to] = src.data[from] ?? 0;
      dest.data[to + 1] = src.data[from + 1] ?? 0;
      dest.data[to + 2] = src.data[from + 2] ?? 0;
      dest.data[to + 3] = src.data[from + 3] ?? 255;
    }
  }
}

function drawText(png: PNG, text: string, x: number, y: number, color: readonly [number, number, number, number]): void {
  const scale = 2;
  let cursor = x;
  for (const char of text) {
    const rows = GLYPHS[char];
    if (!rows) continue;
    rows.forEach((bits, row) => {
      for (let col = 0; col < 5; col += 1) {
        if ((bits & (1 << (4 - col))) === 0) continue;
        for (let sy = 0; sy < scale; sy += 1) {
          for (let sx = 0; sx < scale; sx += 1) setPixel(png, cursor + col * scale + sx, y + row * scale + sy, color);
        }
      }
    });
    cursor += 6 * scale;
  }
}

function renderDualCard(left: Uint8Array, right: Uint8Array): Uint8Array {
  const creation = PNG.sync.read(Buffer.from(left));
  const openclaw = PNG.sync.read(Buffer.from(right));
  const card = new PNG({ width: 720, height: 420 });
  card.data.fill(255);
  const orange = [254, 80, 0, 255] as const;
  const ink = [7, 8, 12, 255] as const;
  strokeRound(card, 28, 48, creation.width + 24, creation.height + 24, 18, 4, orange);
  blit(card, creation, 40, 60);
  blit(card, openclaw, 40 + creation.width + 56, 60);
  drawText(card, "CREATION", 40, 22, orange);
  drawText(card, "OPENCLAW", 40 + creation.width + 56, 22, ink);
  return Uint8Array.from(PNG.sync.write(card));
}

export function qrCardTokens(gatewayToken: string | undefined): {
  readonly creation: string | undefined;
  readonly openClaw: string;
} {
  const trimmed = gatewayToken?.trim() ?? "";
  if (trimmed === "") return { creation: undefined, openClaw: "dev-token" };
  return { creation: trimmed, openClaw: trimmed };
}

export async function generateQrMain(argv: readonly string[], env: GatewayBindings): Promise<void> {
  const origin = argv[2]?.startsWith("http") ? argv[2] : "https://stark-r1.local";
  const cards = qrCardTokens(env.GATEWAY_TOKEN);
  const created = creationQr(origin, cards.creation);
  const wss = openClawWss(new URL(origin).hostname, cards.openClaw);
  if (!created.ok) throw new Error(created.reason);
  if (!wss.ok) throw new Error(wss.reason);
  const creationPng = await renderPng(created.text);
  const wssPng = await renderPng(wss.text);
  const card = renderDualCard(creationPng, wssPng);
  const files = [creationPng, wssPng, card];
  for (const dir of DIRS) {
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < NAMES.length; index += 1) {
      const name = NAMES[index];
      const bytes = files[index];
      if (!name || !bytes) continue;
      await writeFile(join(dir, name), bytes);
    }
  }
}

const scriptPath = process.argv[1];
if (scriptPath !== undefined && import.meta.url === pathToFileURL(scriptPath).href) {
  await generateQrMain(process.argv, { GATEWAY_TOKEN: process.env.GATEWAY_TOKEN });
}
