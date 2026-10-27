import { afterEach, describe, expect, it, vi } from "vitest";
import { startDrive } from "../src/drive";
import type { DeviceState, SpeakPayload } from "../src/device";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startDrive", () => {
  it("waits 250ms, cycles presets instead of sending, then speaks a reply in send order", async () => {
    const timers: { delayMs: number; fire: () => void; cancelled: boolean }[] = [];
    const calls: { message: string }[] = [];
    const spoken: SpeakPayload[] = [];
    const screens: DeviceState[] = [];
    let now = 5_000;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as { message: string });
      return new Response(
        JSON.stringify({
          ok: true,
          reply: calls.length === 1 ? "First" : "Second",
          model: "local-friday",
          personaId: "friday",
          routedToGrokBot: false,
        }),
      );
    });
    const drive = startDrive({
      now: () => now,
      loadToken: () => Promise.resolve(null),
      capture: () => Promise.resolve("lights"),
      speak(payload) {
        spoken.push(payload);
      },
      exit() {},
      schedule(delayMs, fire) {
        const timer = { delayMs, fire, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      render(state) {
        screens.push(state);
      },
    });
    drive.control("sideClick");
    drive.control("sideClick");
    expect(timers[0]?.delayMs).toBe(250);
    expect(timers[0]?.cancelled).toBe(true);
    expect(screens.at(-1)?.presetId).toBe("brief");
    timers[0]?.fire();
    await Promise.resolve();
    expect(calls).toEqual([]);

    drive.control("toggleSpeaker");
    now = 8_000;
    drive.control("sideClick");
    timers.at(-1)?.fire();
    await vi.waitFor(() =>
      expect(calls.map((call) => call.message)).toEqual(["[R1 -> F.R.I.D.A.Y.] Brief me on what matters today."]),
    );
    await vi.waitFor(() =>
      expect(spoken).toEqual([{ message: "First", useLLM: true, wantsR1Response: true, wantsJournalEntry: false }]),
    );

    drive.control("longPressStart");
    drive.control("longPressEnd");
    await vi.waitFor(() => expect(calls.map((call) => call.message)).toContain("[R1 -> F.R.I.D.A.Y.] lights"));
    await vi.waitFor(() =>
      expect(spoken).toEqual([
        { message: "First", useLLM: true, wantsR1Response: true, wantsJournalEntry: false },
        { message: "Second", useLLM: true, wantsR1Response: true, wantsJournalEntry: false },
      ]),
    );
    drive.wheel(12);
    expect(screens.at(-1)?.personaId).toBe("jarvis");
    drive.wheel(-3);
    expect(screens.at(-1)?.personaId).toBe("friday");
    drive.control("exit");
  });
});
