import { describe, expect, it } from "vitest";
import { FRAME_COLOR, nextPreset, PERSONAS, QUICK_PRESETS, type PresetId } from "../src/domain";
import { initialDevice, reduceDevice, type DeviceState } from "../src/device";

function arm(state: DeviceState, nowMs: number): DeviceState {
  const step = reduceDevice(state, { type: "sideClick", nowMs });
  expect(step.effects).toEqual([
    { type: "armSideTimer", fireAtMs: nowMs + 250, delayMs: 250 },
  ]);
  return step.state;
}

describe("roster", () => {
  it("keeps friday first and the scroll accents in order", () => {
    expect(FRAME_COLOR).toBe("#FE5000");
    expect(
      PERSONAS.map((persona) => ({
        id: persona.id,
        label: persona.label,
        role: persona.role,
        accents: [...persona.accents],
      })),
    ).toEqual([
      { id: "friday", label: "F.R.I.D.A.Y.", role: "AGI Chief", accents: ["#FF4D00", "#F59E0B"] },
      { id: "jarvis", label: "J.A.R.V.I.S.", role: "Lead Engineer", accents: ["#38BDF8"] },
      { id: "edith", label: "E.D.I.T.H.", role: "Comms", accents: ["#A855F7"] },
      { id: "ev", label: "E.V.", role: "Product Alert", accents: ["#10B981"] },
      { id: "karen", label: "Karen", role: "Calendar", accents: ["#EC4899"] },
      { id: "dume", label: "Dum-E", role: "Ops Dump", accents: ["#EAB308"] },
    ]);
  });
});

describe("reduceDevice", () => {
  it("scrolls the roster and wraps at both ends", () => {
    let state = initialDevice();
    expect(state.personaId).toBe("friday");
    state = reduceDevice(state, { type: "scroll", direction: "up" }).state;
    expect(state.personaId).toBe("dume");
    state = reduceDevice(state, { type: "scroll", direction: "down" }).state;
    expect(state.personaId).toBe("friday");
    for (const persona of PERSONAS) {
      expect(state.personaId).toBe(persona.id);
      state = reduceDevice(state, { type: "scroll", direction: "down" }).state;
    }
    expect(state.personaId).toBe("friday");
  });

  it("cycles presets on a second side click inside 250ms and does not send", () => {
    const first = reduceDevice(initialDevice(), { type: "sideClick", nowMs: 1_000 });
    expect(first.effects).toEqual([{ type: "armSideTimer", fireAtMs: 1_250, delayMs: 250 }]);
    expect(first.state.gesture).toEqual({ tag: "side-pending", sinceMs: 1_000 });
    const second = reduceDevice(first.state, { type: "sideClick", nowMs: 1_249 });
    expect(second.effects.some((effect) => effect.type === "submit")).toBe(false);
    expect(second.state.presetId).toBe("brief");
    expect(second.state.gesture).toEqual({ tag: "idle" });
    const late = reduceDevice(second.state, { type: "sideTimer", nowMs: 1_250 });
    expect(late.effects).toEqual([]);
    let state = initialDevice();
    let preset: PresetId = "status";
    for (let i = 0; i < QUICK_PRESETS.length; i += 1) {
      state = arm(state, i * 1_000);
      const cycled = reduceDevice(state, { type: "sideClick", nowMs: i * 1_000 + 10 });
      preset = nextPreset(preset);
      expect(cycled.state.presetId).toBe(preset);
      state = cycled.state;
    }
  });

  it("sends the composer when it has text and the preset when it does not", () => {
    const armed = arm(initialDevice(), 0);
    const preset = reduceDevice(armed, { type: "sideTimer", nowMs: 250 });
    expect(preset.effects).toEqual([
      {
        type: "submit",
        text: "Give me a status report.",
        personaId: "friday",
        history: [],
      },
    ]);
    expect(preset.effects[0]?.type === "submit" && preset.effects[0].text.startsWith("[R1 ->")).toBe(false);
    expect(preset.state.transcript).toEqual([{ role: "user", content: "Give me a status report." }]);
    const typed = reduceDevice(initialDevice(), { type: "composer", text: "Hello" }).state;
    const sent = reduceDevice(arm(typed, 10), { type: "sideTimer", nowMs: 260 });
    expect(sent.effects).toEqual([
      { type: "submit", text: "Hello", personaId: "friday", history: [] },
    ]);
    const blocked = reduceDevice(arm(sent.state, 400), { type: "sideTimer", nowMs: 650 });
    expect(blocked.effects).toEqual([]);
    expect(blocked.state.turn.tag).toBe("pending");
    const answered = reduceDevice(sent.state, { type: "reply", sent: "Hello", reply: "Hi" }).state;
    const again = reduceDevice(arm(answered, 800), { type: "sideTimer", nowMs: 1_050 });
    expect(again.effects[0]).toMatchObject({
      type: "submit",
      text: "Give me a status report.",
      history: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ],
    });
  });

  it("captures speech on long-press release and sends heard text or the fallback", () => {
    const idleEnd = reduceDevice(initialDevice(), { type: "longPressEnd" });
    expect(idleEnd.effects).toEqual([]);
    expect(idleEnd.state.gesture).toEqual({ tag: "idle" });
    const armed = reduceDevice(initialDevice(), { type: "longPressStart" });
    expect(armed.state.gesture).toEqual({ tag: "ptt-armed" });
    expect(armed.effects).toEqual([]);
    const held = reduceDevice(
      reduceDevice(initialDevice(), { type: "composer", text: "hold this" }).state,
      { type: "longPressStart" },
    ).state;
    const released = reduceDevice(held, { type: "longPressEnd" });
    expect(released.effects).toEqual([{ type: "capture-speech" }]);
    expect(released.state.gesture).toEqual({ tag: "awaiting-utterance", fallback: "hold this" });
    const heard = reduceDevice(released.state, { type: "utterance", heard: "lights" });
    expect(heard.effects).toEqual([
      { type: "submit", text: "lights", personaId: "friday", history: [] },
    ]);
    const blank = reduceDevice(released.state, { type: "utterance", heard: "   " });
    const missing = reduceDevice(released.state, { type: "utterance", heard: null });
    expect(blank.effects[0]).toMatchObject({ type: "submit", text: "hold this" });
    expect(missing.effects[0]).toMatchObject({ type: "submit", text: "hold this" });
  });

  it("emits the Rabbit speech payload only when the speaker is on", () => {
    const pending = reduceDevice(arm(initialDevice(), 0), { type: "sideTimer", nowMs: 250 }).state;
    const quiet = reduceDevice(pending, { type: "reply", sent: pending.turn.tag === "pending" ? pending.turn.text : "", reply: "Ready" });
    expect(quiet.effects).toEqual([]);
    expect(quiet.state.transcript.at(-1)).toEqual({ role: "assistant", content: "Ready" });
    const loudState = reduceDevice(pending, { type: "toggleSpeaker" }).state;
    const sent = pending.turn.tag === "pending" ? pending.turn.text : "";
    const loud = reduceDevice(loudState, { type: "reply", sent, reply: "Ready" });
    expect(loud.effects).toEqual([
      {
        type: "speak",
        payload: {
          message: "Ready",
          useLLM: true,
          wantsR1Response: true,
          wantsJournalEntry: false,
        },
      },
    ]);
    const exit = reduceDevice(loud.state, { type: "exit" });
    expect(exit.effects).toEqual([{ type: "closeWebView" }]);
  });
});
