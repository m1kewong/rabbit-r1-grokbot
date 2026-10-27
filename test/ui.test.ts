import { describe, expect, it } from "vitest";
import { chromeMode } from "../src/ui";

describe("chromeMode", () => {
  it("keeps the cockpit on /qr even when the viewport is narrow", () => {
    expect(chromeMode({ path: "/qr", search: "", viewportWidth: 200 })).toBe("cockpit");
    expect(chromeMode({ path: "/", search: "?mode=qr", viewportWidth: 240 })).toBe("cockpit");
    expect(chromeMode({ path: "/qr", search: "?r1=1", viewportWidth: 200 })).toBe("cockpit");
  });

  it("uses the bare 240 screen for r1=1 or a width at or under 260", () => {
    expect(chromeMode({ path: "/", search: "?r1=1", viewportWidth: 1440 })).toBe("bare");
    expect(chromeMode({ path: "/", search: "", viewportWidth: 260 })).toBe("bare");
    expect(chromeMode({ path: "/", search: "", viewportWidth: 261 })).toBe("bezel");
  });
});
