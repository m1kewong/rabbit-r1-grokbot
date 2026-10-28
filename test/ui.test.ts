// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { initialDevice, reduceDevice } from "../src/device";
import { startDrive } from "../src/drive";
import { CREATION_URL_VERSION } from "../src/qr";
import { chromeMode, paint } from "../src/ui";

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

describe("creation composer", () => {
  it("keeps the focused composer across a keystroke, a resize, and a persona change", async () => {
    window.history.replaceState(null, "", "/?r1=1");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 240 });
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const drive = startDrive({
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
    expect(root.querySelector(".side")).toBeNull();
    expect(root.querySelector(".screen")?.classList.contains("sheet-open")).toBe(false);
    expect(root.querySelector(".neuron-gif")?.getAttribute("src")).toBe(`/neuron-idle.png?v=${CREATION_URL_VERSION}`);
    expect(root.querySelector(".avatar")?.getAttribute("src")).toBe("/avatars/friday.png");
    expect(root.querySelector(".sheet")?.hasAttribute("hidden")).toBe(true);
    const neuron = root.querySelector(".neuron");
    expect(neuron).toBeInstanceOf(HTMLButtonElement);
    neuron?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    neuron?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(root.querySelector(".sheet")?.hasAttribute("hidden")).toBe(false);
    expect(root.querySelector(".screen")?.classList.contains("sheet-open")).toBe(true);
    const input = root.querySelector("#composer");
    expect(input).toBeInstanceOf(HTMLInputElement);
    if (!(input instanceof HTMLInputElement)) return;
    input.focus();
    expect(document.activeElement).toBe(input);
    input.value = "hi";
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector("#composer")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("hi");
    expect(input.selectionStart).toBe(2);
    window.dispatchEvent(new Event("resize"));
    expect(root.querySelector("#composer")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    drive.wheel(12);
    expect(root.querySelector("#composer")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(root.querySelector("h1")?.textContent).toBe("J.A.R.V.I.S.");
    drive.control("longPressStart");
    expect(root.textContent).toContain("Listening");
    expect(root.querySelector(".neuron-gif")?.getAttribute("src")).toBe(`/neuron-listen.png?v=${CREATION_URL_VERSION}`);
    expect(root.querySelector(".sheet")?.hasAttribute("hidden")).toBe(false);
    drive.control("longPressEnd");
    await Promise.resolve();
    await Promise.resolve();
    expect(root.textContent).toContain("No speech");
    expect(root.querySelector(".neuron-gif")?.getAttribute("src")).toBe(`/neuron-idle.png?v=${CREATION_URL_VERSION}`);
    expect(root.querySelector("#composer")).toBe(input);
    expect(input.value).toBe("hi");
    const preview = reduceDevice(
      reduceDevice(reduceDevice(initialDevice(), { type: "composer", text: "hi" }).state, {
        type: "longPressStart",
      }).state,
      { type: "partial", text: "  <bay>  " },
    ).state;
    root.replaceChildren();
    paint(root, window, preview, () => {});
    expect(root.querySelector(".listen")?.textContent).toBe("<bay>");
    expect(root.querySelector("[data-bind=log]")?.textContent).toContain("<bay>");
    const typed = root.querySelector("#composer");
    expect(typed).toBeInstanceOf(HTMLInputElement);
    if (!(typed instanceof HTMLInputElement)) return;
    expect(typed.value).toBe("hi");
    paint(root, window, reduceDevice(preview, { type: "partial", text: "door" }).state, () => {});
    expect(root.querySelector(".listen")?.textContent).toBe("door");
    expect(root.querySelector("[data-bind=log]")?.textContent).toContain("door");
    expect(root.querySelector("#composer")).toBe(typed);
    expect(typed.value).toBe("hi");
  });
});
