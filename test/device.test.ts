import { describe, expect, it } from "vitest";
import { FRAME_COLOR, nextPreset, PERSONAS, QUICK_PRESETS, type PresetId } from "../src/domain";
import { buildSpeakPayload, initialDevice, reduceDevice, type DeviceState } from "../src/device";

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

  it("starts a hold without sending and ignores a second start", () => {
    const idleEnd = reduceDevice(initialDevice(), { type: "longPressEnd" });
    expect(idleEnd.effects).toEqual([]);
    expect(idleEnd.state.gesture).toEqual({ tag: "idle" });
    const armed = reduceDevice(initialDevice(), { type: "longPressStart" });
    expect(armed.state.gesture).toEqual({ tag: "ptt-armed", partial: "" });
    expect(armed.effects).toEqual([{ type: "ptt-start" }]);
    expect(reduceDevice(armed.state, { type: "longPressStart" }).effects).toEqual([]);
    const released = reduceDevice(armed.state, { type: "longPressEnd" });
    expect(released.effects).toEqual([{ type: "ptt-stop" }]);
    expect(released.state.gesture).toEqual({ tag: "awaiting-utterance" });
    const clicked = reduceDevice(initialDevice(), { type: "sideClick", nowMs: 50 });
    const over = reduceDevice(clicked.state, { type: "longPressStart" });
    expect(over.effects).toEqual([{ type: "cancel-wait" }, { type: "ptt-start" }]);
    const late = reduceDevice(over.state, { type: "sideTimer", nowMs: 300 });
    expect(late.effects).toEqual([]);
    expect(late.state.gesture).toEqual({ tag: "ptt-armed", partial: "" });
  });

  it("shows a partial on the armed hold and does not send it", () => {
    const idle = initialDevice();
    const ignored = reduceDevice(idle, { type: "partial", text: "no" });
    expect(ignored.effects).toEqual([]);
    expect(ignored.state).toBe(idle);
    const armed = reduceDevice(idle, { type: "longPressStart" });
    const preview = reduceDevice(armed.state, { type: "partial", text: "早" });
    expect(preview.effects).toEqual([]);
    expect(preview.state.gesture).toEqual({ tag: "ptt-armed", partial: "早" });
    expect(preview.state.composer).toBe("");
    expect(preview.state.transcript).toEqual([]);
    const repeat = reduceDevice(preview.state, { type: "partial", text: "早" });
    expect(repeat.state).toBe(preview.state);
    const released = reduceDevice(preview.state, { type: "longPressEnd" });
    expect(released.state.gesture).toEqual({ tag: "awaiting-utterance" });
    const late = reduceDevice(released.state, { type: "partial", text: "late" });
    expect(late.state).toBe(released.state);
    expect(late.effects).toEqual([]);
  });

  it("aborts a hold that hears nothing and keeps the unsent draft", () => {
    const drafted = reduceDevice(initialDevice(), { type: "composer", text: "draft" }).state;
    const released = reduceDevice(
      reduceDevice(drafted, { type: "longPressStart" }).state,
      { type: "longPressEnd" },
    );
    const missing = reduceDevice(released.state, { type: "utterance", heard: null });
    const blank = reduceDevice(released.state, { type: "utterance", heard: "   " });
    const heard = reduceDevice(released.state, { type: "utterance", heard: "lights" });
    expect(missing.effects).toEqual([]);
    expect(blank.effects).toEqual([]);
    expect(missing.state.transcript).toEqual([]);
    expect(blank.state.transcript).toEqual([]);
    expect(missing.state.composer).toBe("draft");
    expect(blank.state.composer).toBe("draft");
    expect(missing.state.gesture).toEqual({ tag: "idle" });
    expect(missing.state.turn).toEqual({ tag: "silent" });
    expect(heard.effects).toEqual([
      { type: "submit", text: "lights", personaId: "friday", history: [] },
    ]);
    expect(heard.state.composer).toBe("");
  });

  it("emits the Rabbit speech payload only when the speaker is on", () => {
    const ready = buildSpeakPayload("Ready");
    expect(ready.message).toBe(
      "Read the following text aloud exactly, word for word. Do not add, omit, translate, or summarize anything.\n\n<<<\nReady\n>>>",
    );
    expect(ready.useLLM).toBe(true);
    expect(ready.wantsR1Response).toBe(true);
    expect(ready.wantsJournalEntry).toBe(false);
    expect(buildSpeakPayload("see >>> this").message).toBe(
      "Read the following text aloud exactly, word for word. Do not add, omit, translate, or summarize anything.\n\n<<<\nsee >>> this\n>>>",
    );
    const pending = reduceDevice(arm(initialDevice(), 0), { type: "sideTimer", nowMs: 250 }).state;
    const quiet = reduceDevice(pending, { type: "reply", sent: pending.turn.tag === "pending" ? pending.turn.text : "", reply: "Ready" });
    expect(quiet.effects).toEqual([]);
    expect(quiet.state.transcript.at(-1)).toEqual({ role: "assistant", content: "Ready" });
    const loudState = reduceDevice(pending, { type: "toggleSpeaker" }).state;
    const sent = pending.turn.tag === "pending" ? pending.turn.text : "";
    const loud = reduceDevice(loudState, { type: "reply", sent, reply: "Ready" });
    expect(loud.effects).toEqual([{ type: "speak", payload: buildSpeakPayload("Ready") }]);
    const exit = reduceDevice(loud.state, { type: "exit" });
    expect(exit.effects).toEqual([{ type: "closeWebView" }]);
  });
});


describe("ear report and mic level", () => {
  it("starts on standby and records which engine heard the hold", () => {
    expect(initialDevice().ear).toEqual({ engine: "standby", note: null });
    expect(initialDevice().level).toBe(0);
    const scribe = reduceDevice(initialDevice(), { type: "ear", engine: "scribe", note: null });
    expect(scribe.state.ear).toEqual({ engine: "scribe", note: null });
    expect(scribe.effects).toEqual([]);
    const failed = reduceDevice(scribe.state, { type: "ear", engine: "r1", note: "AUTH" });
    expect(failed.state.ear).toEqual({ engine: "r1", note: "AUTH" });
    const again = reduceDevice(failed.state, { type: "ear", engine: "r1", note: "AUTH" });
    expect(again.state).toBe(failed.state);
  });

  it("quantizes the level while armed and drops it on release", () => {
    const idle = reduceDevice(initialDevice(), { type: "level", level: 0.9 });
    expect(idle.state.level).toBe(0);
    const armed = reduceDevice(initialDevice(), { type: "longPressStart" }).state;
    const loud = reduceDevice(armed, { type: "level", level: 0.51 });
    expect(loud.state.level).toBe(0.5);
    expect(reduceDevice(loud.state, { type: "level", level: 0.53 }).state).toBe(loud.state);
    expect(reduceDevice(loud.state, { type: "level", level: 7 }).state.level).toBe(1);
    expect(reduceDevice(loud.state, { type: "level", level: -3 }).state.level).toBe(0);
    expect(reduceDevice(loud.state, { type: "level", level: Number.NaN }).state.level).toBe(0);
    const released = reduceDevice(loud.state, { type: "longPressEnd" }).state;
    expect(released.level).toBe(0);
    expect(reduceDevice(released, { type: "level", level: 0.9 }).state.level).toBe(0);
  });
});


describe("voice report", () => {
  it("records what happened to the spoken reply and clears on the next submit", () => {
    expect(initialDevice().voice).toEqual({ state: "none", note: null });
    const sent = reduceDevice(initialDevice(), { type: "voice", state: "sent", note: null });
    expect(sent.state.voice).toEqual({ state: "sent", note: null });
    expect(sent.effects).toEqual([]);
    expect(reduceDevice(sent.state, { type: "voice", state: "sent", note: null }).state).toBe(sent.state);
    const echo = reduceDevice(sent.state, { type: "voice", state: "echo", note: "Sure." });
    expect(echo.state.voice).toEqual({ state: "echo", note: "Sure." });
    const next = reduceDevice(echo.state, { type: "composer", text: "again" }).state;
    const submitted = reduceDevice({ ...next, gesture: { tag: "drafting" } }, { type: "sendDraft" });
    expect(submitted.effects.some((effect) => effect.type === "submit")).toBe(true);
    expect(submitted.state.voice).toEqual({ state: "none", note: null });
  });
});
