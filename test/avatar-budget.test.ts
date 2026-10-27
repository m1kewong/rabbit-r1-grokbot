import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MAX_EDGE = 64;
const MAX_BYTES = 20 * 1024;

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("public/avatars", () => {
  it("keeps every persona image at or under 64px and 20KB", () => {
    const dir = new URL("../public/avatars/", import.meta.url);
    const names = readdirSync(dir);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const bytes = readFileSync(new URL(name, dir));
      expect(bytes.byteLength, name).toBeLessThanOrEqual(MAX_BYTES);
      const { width, height } = pngSize(bytes);
      expect(width, name).toBeLessThanOrEqual(MAX_EDGE);
      expect(height, name).toBeLessThanOrEqual(MAX_EDGE);
    }
  });
});
