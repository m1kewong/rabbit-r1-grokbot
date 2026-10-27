import "./styles.css";
import { getHealth } from "./client";
import { PERSONAS, personaById, presetById, type HealthStatus, type Persona } from "./domain";
import { startDrive } from "./drive";
import { type DeviceEvent, type DeviceState, type SpeakPayload } from "./device";
import { creationQr, openClawForLocation, renderDataUrl } from "./qr";

const SCREEN_STYLE = "width:240px; height:282px; overflow:hidden";
const DEFAULT_BRIDGE = "https://even-g2-bridge.saviormike.workers.dev";
const CHAT_TOKEN_KEY = "stark-chat-token";
const GATEWAY_TOKEN_KEY = "stark-gateway-token";
const BRIDGE_KEY = "stark-bridge-url";

export type ChromeMode = "bare" | "bezel" | "cockpit";

type R1Window = Window & {
  closeWebView?: { postMessage(message: string): void };
  PluginMessageHandler?: { postMessage(message: string): void };
  onPluginMessage?: (data: unknown) => void;
  creationStorage?: {
    secure?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
  };
  SpeechRecognition?: new () => SpeechRec;
  webkitSpeechRecognition?: new () => SpeechRec;
};

type SpeechRec = {
  lang: string;
  start(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

type HealthView = "unknown" | HealthStatus | { ok: false; error: "network" };

type ChromeFields = {
  bridgeUrl: string;
  gatewayToken: string;
  health: HealthView;
};

const chrome: ChromeFields = {
  bridgeUrl: DEFAULT_BRIDGE,
  gatewayToken: "",
  health: "unknown",
};

let qrCache: { key: string; creation: string; openclaw: string } | null = null;
let healthStarted = false;
let wired = false;
let caret: { id: string; pos: number } | null = null;

export function chromeMode(input: {
  readonly path: string;
  readonly search: string;
  readonly viewportWidth: number;
}): ChromeMode {
  const params = new URLSearchParams(input.search.replace(/^\?/, ""));
  if (input.path === "/qr" || params.get("mode") === "qr") return "cockpit";
  if (params.get("r1") === "1" || input.viewportWidth <= 260) return "bare";
  return "bezel";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function healthText(status: HealthView): string {
  if (status === "unknown") return "Checking gateway";
  if (status.ok) return `${status.service} protocol ${status.protocolMin}-${status.protocolMax}`;
  return "Gateway unreachable";
}

function screenMarkup(state: DeviceState, persona: Persona): string {
  const accent = persona.accents[0];
  const dots = PERSONAS.map((item) => `<i class="${item.id === state.personaId ? "on" : ""}"></i>`).join("");
  const lines =
    state.transcript.length === 0
      ? `<p class="hint">Side click sends. Hold Side to talk.</p>`
      : state.transcript
          .map((turn) => {
            const who = turn.role === "user" ? "You" : persona.label;
            return `<p class="line ${turn.role}"><span>${escapeHtml(who)}</span>${escapeHtml(turn.content)}</p>`;
          })
          .join("");
  const status =
    state.turn.tag === "pending"
      ? `<p class="line pending"><span>Link</span>Sending</p>`
      : state.turn.tag === "failed"
        ? `<p class="line failed"><span>Link</span>No reply</p>`
        : "";
  return `<section class="screen" data-screen="stark-r1" style="${SCREEN_STYLE}">
    <header class="top">
      <div class="brand">
        <svg class="bolt" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2" fill="none" stroke="#FE5000" stroke-width="1.6"/><circle cx="8" cy="8" r="1.6" fill="#F59E0B"/></svg>
        <b>STARK</b><span>R1</span>
      </div>
      <div class="actions">
        <button type="button" data-control="speaker" aria-pressed="${state.speakerOn ? "true" : "false"}">SPK</button>
        <button type="button" data-control="exit">Exit</button>
      </div>
    </header>
    <div class="who">
      <i class="accent" style="background:${accent}"></i>
      <div>
        <h1 style="color:${accent}">${escapeHtml(persona.label)}</h1>
        <p>${escapeHtml(persona.role)}</p>
        <div class="ticks">${dots}</div>
      </div>
    </div>
    <div class="log">${lines}${status}</div>
    <p class="preset"><span>Preset</span>${escapeHtml(presetById(state.presetId).text)}</p>
    <input id="composer" class="composer" aria-label="Message" value="${escapeHtml(state.composer)}" />
    <button type="button" class="side" data-ptt="1">Side</button>
  </section>`;
}

function bezelMarkup(state: DeviceState, persona: Persona): string {
  return `<div class="bezel">
    ${screenMarkup(state, persona)}
    <div class="bezel-keys">
      <button type="button" data-control="scroll-up">Scroll Up</button>
      <button type="button" data-control="scroll-down">Scroll Down</button>
      <button type="button" data-ptt="1">Side PTT</button>
    </div>
  </div>`;
}

function cockpitMarkup(state: DeviceState, persona: Persona, target: Window): string {
  const cached = qrCache?.key === qrKey(target) ? qrCache : null;
  return `<div class="cockpit">
    <header class="cockpit-head">
      <div>
        <h1>Stark R1</h1>
        <p>F.R.I.D.A.Y. &amp; Grok Bot Communicator for Rabbit R1</p>
      </div>
      <p class="health" data-health>${escapeHtml(healthText(chrome.health))}</p>
    </header>
    <div class="cockpit-grid">
      <div>
        <div class="qr-row">
          <article class="qr-card creation">
            <h2>Creation</h2>
            <div class="qr-frame creation">
              <img class="qr creation-qr" alt="Creation QR" width="220" height="220" src="${cached?.creation ?? ""}" />
            </div>
          </article>
          <article class="qr-card openclaw">
            <h2>OpenClaw</h2>
            <div class="qr-frame">
              <img class="qr openclaw-qr" alt="OpenClaw QR" width="220" height="220" src="${cached?.openclaw ?? ""}" />
            </div>
          </article>
        </div>
        <form class="fields">
          <label class="field">Bridge URL
            <input id="bridge-url" name="bridge" autocomplete="off" value="${escapeHtml(chrome.bridgeUrl)}" />
          </label>
          <label class="field">Gateway token
            <input id="gateway-token" name="token" autocomplete="off" value="${escapeHtml(chrome.gatewayToken)}" />
          </label>
        </form>
      </div>
      <div class="sim">${bezelMarkup(state, persona)}</div>
    </div>
  </div>`;
}

function qrKey(target: Window): string {
  return `${target.location.origin}\n${chrome.gatewayToken}`;
}

function ensureQr(target: Window): void {
  const key = qrKey(target);
  if (qrCache?.key === key && qrCache.creation && qrCache.openclaw) return;
  const creation = creationQr(target.location.origin);
  const open = openClawForLocation(
    { protocol: target.location.protocol, hostname: target.location.hostname },
    chrome.gatewayToken,
  );
  if (!creation.ok || !open.ok) return;
  void Promise.all([renderDataUrl(creation.text), renderDataUrl(open.text)]).then(([left, right]) => {
    if (qrKey(target) !== key) return;
    qrCache = { key, creation: left, openclaw: right };
    const creationImg = target.document.querySelector("img.creation-qr");
    const openImg = target.document.querySelector("img.openclaw-qr");
    if (creationImg instanceof HTMLImageElement) creationImg.src = left;
    if (openImg instanceof HTMLImageElement) openImg.src = right;
  });
}

function ensureHealth(target: Window): void {
  if (healthStarted) return;
  healthStarted = true;
  const pull = (): void => {
    void getHealth().then((status) => {
      chrome.health = status;
      const node = target.document.querySelector("[data-health]");
      if (node) node.textContent = healthText(status);
    });
  };
  pull();
  target.setInterval(pull, 10_000);
}

function restoreCaret(root: HTMLElement): void {
  const id = caret?.id ?? "";
  const pos = caret?.pos ?? null;
  caret = null;
  if (!id) return;
  const next = root.querySelector(`#${id}`);
  if (!(next instanceof HTMLInputElement)) return;
  next.focus();
  const point = pos ?? next.value.length;
  next.setSelectionRange(point, point);
}

function wire(root: HTMLElement, target: Window, dispatch: (event: DeviceEvent) => void): void {
  if (wired) return;
  wired = true;
  let pressTimer: number | null = null;
  let armed = false;
  root.addEventListener("pointerdown", (event) => {
    const node = event.target;
    if (!(node instanceof Element) || !node.closest("[data-ptt]")) return;
    armed = false;
    if (pressTimer !== null) target.clearTimeout(pressTimer);
    pressTimer = target.setTimeout(() => {
      armed = true;
      pressTimer = null;
      dispatch({ type: "longPressStart" });
    }, 450);
  });
  const endPress = (event: Event): void => {
    const node = event.target;
    if (!(node instanceof Element)) return;
    const held = Boolean(node.closest("[data-ptt]"));
    if (!held && !armed) return;
    if (pressTimer !== null) {
      target.clearTimeout(pressTimer);
      pressTimer = null;
    }
    if (armed) {
      armed = false;
      dispatch({ type: "longPressEnd" });
      return;
    }
    if (held) dispatch({ type: "sideClick", nowMs: Date.now() });
  };
  root.addEventListener("pointerup", endPress);
  root.addEventListener("pointercancel", endPress);
  root.addEventListener("click", (event) => {
    const node = event.target;
    if (!(node instanceof Element)) return;
    const control = node.closest("[data-control]");
    if (!(control instanceof HTMLElement)) return;
    if (control.dataset.control === "scroll-up") dispatch({ type: "scroll", direction: "up" });
    if (control.dataset.control === "scroll-down") dispatch({ type: "scroll", direction: "down" });
    if (control.dataset.control === "speaker") dispatch({ type: "toggleSpeaker" });
    if (control.dataset.control === "exit") dispatch({ type: "exit" });
  });
  root.addEventListener("input", (event) => {
    const node = event.target;
    if (!(node instanceof HTMLInputElement)) return;
    caret = { id: node.id, pos: node.selectionStart ?? node.value.length };
    if (node.id === "composer") dispatch({ type: "composer", text: node.value });
    if (node.id === "bridge-url" || node.id === "gateway-token") {
      if (node.id === "bridge-url") chrome.bridgeUrl = node.value;
      else chrome.gatewayToken = node.value;
      saveChrome(target);
      if (!painted) return;
      paint(root, target, painted, dispatch);
    }
  });
}

let painted: DeviceState | null = null;

export function paint(root: HTMLElement, target: Window, state: DeviceState, dispatch: (event: DeviceEvent) => void): void {
  painted = state;
  const persona = personaById(state.personaId);
  const mode = chromeMode({
    path: target.location.pathname,
    search: target.location.search,
    viewportWidth: target.innerWidth,
  });
  target.document.body.dataset.chrome = mode;
  const html =
    mode === "cockpit"
      ? cockpitMarkup(state, persona, target)
      : mode === "bezel"
        ? bezelMarkup(state, persona)
        : screenMarkup(state, persona);
  root.innerHTML = html;
  restoreCaret(root);
  wire(root, target, dispatch);
  if (mode === "cockpit") {
    ensureQr(target);
    ensureHealth(target);
  }
}

export function bindHardware(
  target: Window,
  control: (name: string) => void,
  wheel: (deltaY: number) => void,
): () => void {
  const scrollUp = (): void => control("scrollUp");
  const scrollDown = (): void => control("scrollDown");
  const sideClick = (): void => control("sideClick");
  const longStart = (): void => control("longPressStart");
  const longEnd = (): void => control("longPressEnd");
  const onWheel = (event: Event): void => {
    if (!(event instanceof WheelEvent)) return;
    if (target.document.body.dataset.chrome === "cockpit") {
      const screen = target.document.querySelector("[data-screen]");
      if (!(event.target instanceof Node) || !screen?.contains(event.target)) return;
    }
    wheel(event.deltaY);
  };
  let touchY: number | null = null;
  const onTouchStart = (event: Event): void => {
    if (!(event instanceof TouchEvent)) return;
    touchY = event.changedTouches[0]?.clientY ?? null;
  };
  const onTouchEnd = (event: Event): void => {
    if (!(event instanceof TouchEvent) || touchY === null) return;
    const y = event.changedTouches[0]?.clientY;
    const start = touchY;
    touchY = null;
    if (y === undefined || Math.abs(y - start) < 18) return;
    if (target.document.body.dataset.chrome === "cockpit") {
      const screen = target.document.querySelector("[data-screen]");
      if (!(event.target instanceof Node) || !screen?.contains(event.target)) return;
    }
    wheel(y - start);
  };
  target.addEventListener("scrollUp", scrollUp);
  target.addEventListener("scrollDown", scrollDown);
  target.addEventListener("sideClick", sideClick);
  target.addEventListener("longPressStart", longStart);
  target.addEventListener("longPressEnd", longEnd);
  target.addEventListener("wheel", onWheel);
  target.addEventListener("touchstart", onTouchStart);
  target.addEventListener("touchend", onTouchEnd);
  return () => {
    target.removeEventListener("scrollUp", scrollUp);
    target.removeEventListener("scrollDown", scrollDown);
    target.removeEventListener("sideClick", sideClick);
    target.removeEventListener("longPressStart", longStart);
    target.removeEventListener("longPressEnd", longEnd);
    target.removeEventListener("wheel", onWheel);
    target.removeEventListener("touchstart", onTouchStart);
    target.removeEventListener("touchend", onTouchEnd);
  };
}

function bytesToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToText(value: string): string | null {
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function browserTokens(target: Window = window): {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
} {
  const view = target as R1Window;
  return {
    async load() {
      const secure = view.creationStorage?.secure;
      if (secure) {
        const stored = secure.getItem(CHAT_TOKEN_KEY);
        const decoded = stored ? base64ToText(stored) : null;
        if (decoded) return decoded;
      }
      try {
        return target.localStorage.getItem(CHAT_TOKEN_KEY);
      } catch {
        return null;
      }
    },
    async save(token: string) {
      const secure = view.creationStorage?.secure;
      if (secure) {
        try {
          secure.setItem(CHAT_TOKEN_KEY, bytesToBase64(token));
          return;
        } catch {
          // The secure store rejected the write, so the plain store still records it.
        }
      }
      try {
        target.localStorage.setItem(CHAT_TOKEN_KEY, token);
      } catch {
        // Private mode has no storage.
      }
    },
  };
}

export function postSpeech(payload: SpeakPayload): void {
  (window as R1Window).PluginMessageHandler?.postMessage(JSON.stringify(payload));
}

export function exitWebView(): void {
  (window as R1Window).closeWebView?.postMessage("");
}

function captureSpeech(target: Window): Promise<string | null> {
  const view = target as R1Window;
  const Ctor = view.SpeechRecognition ?? view.webkitSpeechRecognition;
  if (!Ctor) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const rec = new Ctor();
      rec.lang = "en-US";
      rec.onresult = (event) => finish(event.results[0]?.[0]?.transcript ?? null);
      rec.onerror = () => finish(null);
      rec.onend = () => finish(null);
      rec.start();
    } catch {
      finish(null);
    }
  });
}

function loadChrome(target: Window): void {
  try {
    const bridge = target.localStorage.getItem(BRIDGE_KEY);
    if (bridge) chrome.bridgeUrl = bridge;
    chrome.gatewayToken = target.localStorage.getItem(GATEWAY_TOKEN_KEY) ?? "";
  } catch {
    // Private mode keeps the defaults for this page load.
  }
}

function saveChrome(target: Window): void {
  try {
    target.localStorage.setItem(BRIDGE_KEY, chrome.bridgeUrl);
    target.localStorage.setItem(GATEWAY_TOKEN_KEY, chrome.gatewayToken);
  } catch {
    // Private mode cannot persist the cockpit fields.
  }
}

export function boot(root: HTMLElement, target: Window): void {
  loadChrome(target);
  const drive = startDrive({
    now: () => Date.now(),
    loadToken: () => browserTokens(target).load(),
    capture: () => captureSpeech(target),
    speak: postSpeech,
    exit: exitWebView,
    schedule: (delayMs, fire) => {
      const id = target.setTimeout(fire, delayMs);
      return () => target.clearTimeout(id);
    },
    render: (state, dispatch) => {
      paint(root, target, state, dispatch);
    },
    viewport: target,
    pluginTarget: target as R1Window,
  });
  bindHardware(target, drive.control, drive.wheel);
}

if (typeof document !== "undefined") {
  const root = document.querySelector("#root");
  if (root instanceof HTMLElement) boot(root, window);
}
