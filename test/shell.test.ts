import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("creation shell", () => {
  it("sets the R1 viewport and locks the body to 240 by 282", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('name="viewport" content="width=240, initial-scale=1.0, user-scalable=no"');
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/body\s*\{[^}]*width:\s*240px;[^}]*height:\s*282px;[^}]*overflow:\s*hidden;/);
  });

  it("ships a png creation icon at or under 128px and 8KB", () => {
    const bytes = readFileSync(new URL("../public/icon.png", import.meta.url));
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(bytes.readUInt32BE(16)).toBeLessThanOrEqual(128);
    expect(bytes.readUInt32BE(20)).toBeLessThanOrEqual(128);
    expect(bytes.byteLength).toBeLessThanOrEqual(8 * 1024);
  });
});
