import { TTS_PATH, type AudibleReply, type SpeakOutcome } from "./yue";

export type Mouth = {
  speak(text: AudibleReply): Promise<SpeakOutcome>;
  hush(): void;
};

type PluginPoster = {
  postMessage(message: string): void;
};

const READ_ALOUD_FLAGS = {
  useLLM: true,
  wantsR1Response: true,
  wantsJournalEntry: false,
} as const;

function readAloudMessage(reply: string): string {
  return `Read the following text aloud exactly, word for word. Do not add, omit, translate, or summarize anything.

<<<
${reply}
>>>`;
}

export function createMouth(ports: {
  chatBearer(): Promise<string | null>;
  plugin(): PluginPoster | null;
}): Mouth {
  let epoch = 0;
  let clip: HTMLAudioElement | null = null;
  let clipUrl: string | null = null;

  function stopClip(): void {
    const audio = clip;
    const url = clipUrl;
    clip = null;
    clipUrl = null;
    if (audio) audio.pause();
    if (url !== null) URL.revokeObjectURL(url);
  }

  function advance(): number {
    epoch += 1;
    stopClip();
    return epoch;
  }

  function postPlugin(mine: number, text: string): void {
    if (epoch !== mine) return;
    const poster = ports.plugin();
    if (poster === null) return;
    try {
      poster.postMessage(JSON.stringify({ message: readAloudMessage(text), ...READ_ALOUD_FLAGS }));
    } catch {
      return;
    }
  }

  async function playMpeg(mine: number, bytes: Uint8Array): Promise<SpeakOutcome> {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const url = URL.createObjectURL(new Blob([buffer], { type: "audio/mpeg" }));
    const audio = new Audio(url);
    clip = audio;
    clipUrl = url;
    try {
      await audio.play();
    } catch {
      if (epoch !== mine) return { tag: "dropped" };
      if (clip === audio) stopClip();
      return { tag: "failed" };
    }
    if (epoch !== mine) return { tag: "dropped" };
    return { tag: "spoken" };
  }

  return {
    hush() {
      advance();
    },
    async speak(text) {
      const mine = advance();
      try {
        const bearer = await ports.chatBearer();
        if (epoch !== mine) return { tag: "dropped" };
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
        const response = await fetch(TTS_PATH, {
          method: "POST",
          headers,
          body: JSON.stringify({ text }),
        });
        if (epoch !== mine) return { tag: "dropped" };
        if (response.status === 503) {
          postPlugin(mine, text);
          return { tag: "no-key" };
        }
        const type = response.headers.get("content-type") ?? "";
        if (response.status === 200 && type.includes("audio/mpeg")) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (epoch !== mine) return { tag: "dropped" };
          if (bytes.byteLength > 0) return playMpeg(mine, bytes);
        }
        postPlugin(mine, text);
        return { tag: "failed" };
      } catch {
        if (epoch !== mine) return { tag: "dropped" };
        postPlugin(mine, text);
        return { tag: "failed" };
      }
    },
  };
}
