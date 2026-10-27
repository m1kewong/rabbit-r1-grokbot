import { describe, expect, it } from "vitest";
import { captureSpeech } from "../src/ui";

type ResultHandler = (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
type ErrorHandler = (event: { error?: string }) => void;

type Rec = {
  lang: string;
  onresult: ResultHandler | null;
  onerror: ErrorHandler | null;
  onend: (() => void) | null;
  start(): void;
};

function windowWith(RecCtor: new () => Rec): Window {
  return { SpeechRecognition: RecCtor } as unknown as Window;
}

describe("captureSpeech", () => {
  it("asks for zh-HK and keeps an empty result on that language", async () => {
    const langs: string[] = [];
    class Rec {
      lang = "";
      onresult: ResultHandler | null = null;
      onerror: ErrorHandler | null = null;
      onend: (() => void) | null = null;
      start() {
        langs.push(this.lang);
        this.onerror?.({ error: "no-speech" });
        this.onend?.();
      }
    }
    const heard = await captureSpeech(windowWith(Rec));
    expect(langs).toEqual(["zh-HK"]);
    expect(heard).toBeNull();
    expect(langs).not.toContain("en-US");
  });

  it("tries yue-HK then zh-TW only when the language is unsupported", async () => {
    const langs: string[] = [];
    class Rec {
      lang = "";
      onresult: ResultHandler | null = null;
      onerror: ErrorHandler | null = null;
      onend: (() => void) | null = null;
      start() {
        langs.push(this.lang);
        if (this.lang === "zh-HK" || this.lang === "yue-HK") {
          this.onerror?.({ error: "language-not-supported" });
          this.onend?.();
          return;
        }
        this.onresult?.({ results: [[{ transcript: "你好" }]] });
      }
    }
    const heard = await captureSpeech(windowWith(Rec));
    expect(langs).toEqual(["zh-HK", "yue-HK", "zh-TW"]);
    expect(heard).toBe("你好");
  });
});
