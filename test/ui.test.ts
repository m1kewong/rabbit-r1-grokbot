// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { initialDevice, reduceDevice, type DeviceState } from "../src/device";
import { startDrive } from "../src/drive";
import { CREATION_URL_VERSION } from "../src/qr";
import { asrView, boot, browserTokens, chromeMode, paint } from "../src/ui";

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


describe("asrView", () => {
  it("says which engine heard the hold and why Scribe was skipped", () => {
    expect(asrView({ engine: "standby", note: null })).toEqual({ text: "ASR > STANDBY", tone: "idle" });
    expect(asrView({ engine: "scribe", note: null })).toEqual({ text: "ASR > ELEVENLABS SCRIBE", tone: "ok" });
    expect(asrView({ engine: "scribe", note: "SRV-AUTH_ERROR" })).toEqual({
      text: "ASR > SCRIBE ! SRV-AUTH_ERROR",
      tone: "warn",
    });
    expect(asrView({ engine: "r1", note: "AUTH" })).toEqual({ text: "ASR > R1 NATIVE ! AUTH", tone: "warn" });
    expect(asrView({ engine: "browser", note: null })).toEqual({ text: "ASR > BROWSER SR", tone: "warn" });
    expect(asrView({ engine: "none", note: "MIC-DENIED" })).toEqual({ text: "ASR > NO MIC ! MIC-DENIED", tone: "warn" });
  });
});

describe("handset hud", () => {
  function screen(): { root: HTMLElement; show(state: DeviceState): void } {
    window.history.replaceState(null, "", "/?r1=1");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 240 });
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    return { root, show: (state) => paint(root, window, state, () => {}) };
  }

  it("draws the animated rings over the still plate", () => {
    const { root, show } = screen();
    show(initialDevice());
    const rings = root.querySelectorAll(".neuron .hud svg.ring");
    expect(rings).toHaveLength(4);
    expect(root.querySelector(".neuron .hud-core")).not.toBeNull();
    expect(root.querySelector(".neuron .hud-sweep")).not.toBeNull();
    expect(root.querySelector(".neuron img.neuron-gif")).not.toBeNull();
  });

  it("follows the turn through idle, listen, think, and reply", () => {
    const { root, show } = screen();
    let state = initialDevice();
    show(state);
    const live = (): HTMLElement => {
      const node = root.querySelector(".screen");
      if (!(node instanceof HTMLElement)) throw new Error("screen");
      return node;
    };
    expect(live().dataset.mode).toBe("idle");
    expect(live().classList.contains("has-log")).toBe(false);
    expect(root.querySelector(".ready")?.textContent).toBe("READY");

    state = reduceDevice(state, { type: "longPressStart" }).state;
    state = reduceDevice(state, { type: "level", level: 0.5 }).state;
    show(state);
    expect(live().dataset.mode).toBe("listen");
    expect(live().style.getPropertyValue("--lvl")).toBe("0.5");
    expect(root.querySelector(".listen")?.classList.contains("waiting")).toBe(true);

    state = reduceDevice(state, { type: "partial", text: "早晨" }).state;
    show(state);
    expect(root.querySelector(".listen")?.textContent).toBe("早晨");
    expect(root.querySelector(".listen")?.classList.contains("waiting")).toBe(false);

    state = reduceDevice(state, { type: "longPressEnd" }).state;
    state = reduceDevice(state, { type: "utterance", heard: "早晨" }).state;
    show(state);
    expect(live().dataset.mode).toBe("think");
    expect(live().classList.contains("has-log")).toBe(true);
    expect(root.querySelector(".ready")?.textContent).toBe("PROCESSING");
    expect(live().style.getPropertyValue("--lvl")).toBe("0");

    state = reduceDevice(state, { type: "reply", sent: "早晨", reply: "Good morning." }).state;
    show(state);
    expect(live().dataset.mode).toBe("reply");
    expect(root.querySelector("[data-bind=log]")?.textContent).toContain("Good morning.");
  });

  it("shows the engine readout and updates it in place", () => {
    const { root, show } = screen();
    show(initialDevice());
    const asr = root.querySelector(".asr");
    expect(asr?.textContent).toBe("ASR > STANDBY");
    show(reduceDevice(initialDevice(), { type: "ear", engine: "r1", note: "AUTH" }).state);
    expect(root.querySelector(".asr")).toBe(asr);
    expect(asr?.textContent).toBe("ASR > R1 NATIVE ! AUTH");
    expect(asr?.getAttribute("data-tone")).toBe("warn");
  });
});

const PAIR_TOKEN = "paired/token+for stark-r1 gateway secret!!123456";

describe("paired install", () => {
  let secureWrites = 0;

  function secureShelf(): void {
    secureWrites = 0;
    const store = new Map<string, string>();
    Object.defineProperty(window, "creationStorage", {
      configurable: true,
      value: {
        secure: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => {
            secureWrites += 1;
            store.set(key, value);
          },
        },
      },
    });
  }

  function mount(path: string): HTMLElement {
    window.history.replaceState(null, "", path);
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    return root;
  }

  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, "creationStorage");
    secureWrites = 0;
  });

  it("stores the token once and strips t from the url", async () => {
    secureShelf();
    const root = mount(`/?v=20261031-pair&t=${encodeURIComponent(PAIR_TOKEN)}`);
    await boot(root, window);
    await expect(browserTokens().load()).resolves.toBe(PAIR_TOKEN);
    expect(localStorage.getItem("stark-gateway-token")).toBe(PAIR_TOKEN);
    expect(localStorage.getItem("stark-chat-token")).toBeNull();
    expect(window.location.search).toBe("?v=20261031-pair");
    expect(secureWrites).toBe(1);

    window.history.replaceState(null, "", `/?v=20261031-pair&t=${encodeURIComponent(PAIR_TOKEN)}`);
    await boot(root, window);
    expect(secureWrites).toBe(1);
    expect(window.location.search).toBe("?v=20261031-pair");
  });

  it("strips a blank t without writing a token", async () => {
    secureShelf();
    const root = mount("/?v=20261031-pair&t=%20%20");
    await boot(root, window);
    expect(secureWrites).toBe(0);
    expect(localStorage.getItem("stark-gateway-token")).toBeNull();
    expect(localStorage.getItem("stark-chat-token")).toBeNull();
    expect(window.location.search).toBe("?v=20261031-pair");
  });

  it("sends chat with no paired token", async () => {
    secureShelf();
    const calls: { url: string; init?: RequestInit }[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, reply: "ok", personaId: "friday" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const root = mount(`/?v=20261031-pair&t=${encodeURIComponent(PAIR_TOKEN)}`);
      await boot(root, window);
      await Promise.resolve();
      const neuron = root.querySelector(".neuron");
      neuron?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      neuron?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      const input = root.querySelector("#composer");
      expect(input).toBeInstanceOf(HTMLInputElement);
      if (!(input instanceof HTMLInputElement)) return;
      input.value = "hi";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      root.querySelector("[data-send]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      const chats = calls.filter((call) => new URL(call.url, window.location.origin).pathname === "/api/chat");
      expect(chats).toHaveLength(1);
      const chat = chats[0];
      expect(chat).toBeDefined();
      if (!chat) return;
      expect(new Headers(chat.init?.headers).get("authorization")).toBeNull();
      expect(JSON.parse(String(chat.init?.body)).token).toBeNull();
    } finally {
      globalThis.fetch = previous;
    }
  });

  it("shows the paired token in the gateway field", async () => {
    secureShelf();
    const previous = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 503 });
    try {
      const root = mount(`/?v=20261031-pair&t=${encodeURIComponent(PAIR_TOKEN)}`);
      await boot(root, window);
      window.history.replaceState(null, "", "/qr");
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
      paint(root, window, initialDevice(), () => {});
      const field = root.querySelector("#gateway-token");
      expect(field).toBeInstanceOf(HTMLInputElement);
      if (field instanceof HTMLInputElement) expect(field.value).toBe(PAIR_TOKEN);
      await Promise.resolve();
    } finally {
      globalThis.fetch = previous;
    }
  });
});
