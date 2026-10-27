// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startDrive } from "../src/drive";
import { paint } from "../src/ui";

const MAX_BYTES = 30 * 1024;
const MAX_EDGE = 240;

type ImageFacts = { frames: number; width: number; height: number };

function skipSubBlocks(bytes: Buffer, index: number): number {
  let cursor = index;
  while (cursor < bytes.length) {
    const size = bytes[cursor] ?? 0;
    cursor += 1 + size;
    if (size === 0) break;
  }
  return cursor;
}

function gifFacts(bytes: Buffer): ImageFacts {
  let cursor = 6;
  const packed = bytes[cursor + 4] ?? 0;
  const width = bytes.readUInt16LE(cursor);
  const height = bytes.readUInt16LE(cursor + 2);
  cursor += 7;
  if ((packed & 0x80) !== 0) cursor += (1 << ((packed & 7) + 1)) * 3;
  let frames = 0;
  while (cursor < bytes.length) {
    const block = bytes[cursor];
    if (block === 0x3b) break;
    if (block === 0x21) {
      cursor = skipSubBlocks(bytes, cursor + 2);
      continue;
    }
    if (block === 0x2c) {
      frames += 1;
      const local = bytes[cursor + 9] ?? 0;
      cursor += 10;
      if ((local & 0x80) !== 0) cursor += (1 << ((local & 7) + 1)) * 3;
      cursor = skipSubBlocks(bytes, cursor + 1);
      continue;
    }
    throw new Error(`bad gif block ${block ?? 0} at ${cursor}`);
  }
  return { frames, width, height };
}

function pngFacts(bytes: Buffer): ImageFacts {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  let frames = 1;
  let cursor = 8;
  while (cursor + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor);
    const type = bytes.subarray(cursor + 4, cursor + 8).toString("ascii");
    if (type === "acTL" && length >= 4) frames = bytes.readUInt32BE(cursor + 8);
    if (type === "IEND") break;
    cursor += 12 + length;
  }
  return { frames, width, height };
}

function imageFacts(bytes: Buffer): ImageFacts {
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return pngFacts(bytes);
  const sig = bytes.subarray(0, 6).toString();
  if (sig === "GIF87a" || sig === "GIF89a") return gifFacts(bytes);
  throw new Error(`unsupported hero ${sig}`);
}

function mount(): HTMLElement {
  window.history.replaceState(null, "", "/?r1=1");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 240 });
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  startDrive({
    now: () => 0,
    loadToken: () => Promise.resolve(null),
    capture: () => Promise.resolve(null),
    speak() {},
    exit() {},
    schedule: () => () => {},
    render(state, dispatch) {
      paint(root, window, state, dispatch);
    },
    viewport: window,
  });
  return root;
}

function heroBytes(root: ParentNode): { path: string; bytes: Buffer } {
  const src = root.querySelector(".neuron-gif")?.getAttribute("src");
  expect(src, "hero src").toEqual(expect.any(String));
  const path = (src ?? "").split("?")[0] ?? "";
  expect(path.startsWith("/"), path).toBe(true);
  const bytes = readFileSync(join(process.cwd(), "public", path.slice(1)));
  return { path, bytes };
}

function expectStill(root: ParentNode): void {
  const { path, bytes } = heroBytes(root);
  const facts = imageFacts(bytes);
  expect.soft(facts.frames, path).toBeLessThanOrEqual(1);
  expect.soft(facts.width, path).toBeLessThanOrEqual(MAX_EDGE);
  expect.soft(facts.height, path).toBeLessThanOrEqual(MAX_EDGE);
  expect.soft(bytes.byteLength, path).toBeLessThanOrEqual(MAX_BYTES);
}

describe("neuron hero budget", () => {
  it("loads single-frame idle and hold heroes at or under 240px and 30KB", () => {
    const root = mount();
    expectStill(root);
    const neuron = root.querySelector(".neuron");
    expect(neuron).toBeInstanceOf(HTMLButtonElement);
    neuron?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    neuron?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(root.querySelector(".sheet")?.hasAttribute("hidden")).toBe(false);
    expectStill(root);
  });
});
