// Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied. See the License for the
// specific language governing permissions and limitations
// under the License.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, it, expect, vi } from "vitest";
import { buildLiveTranscript, pickLocalVoice, pickSpeechRecognitionCtor, useSpeakText } from "./voice";
import type { SpeechRecognitionConstructor, SpeechRecognitionResultList } from "./voice";

function resultList(entries: { transcript: string; isFinal: boolean }[]): SpeechRecognitionResultList {
  const list = entries.map((entry) => Object.assign([{ transcript: entry.transcript }], { isFinal: entry.isFinal }));
  return Object.assign(list, { length: list.length });
}

describe("pickSpeechRecognitionCtor", () => {
  it("prefers the standard constructor over the vendor-prefixed one", () => {
    const standard = {} as SpeechRecognitionConstructor;
    const prefixed = {} as SpeechRecognitionConstructor;
    expect(pickSpeechRecognitionCtor({ SpeechRecognition: standard, webkitSpeechRecognition: prefixed })).toBe(
      standard,
    );
  });

  it("falls back to the vendor-prefixed constructor", () => {
    const prefixed = {} as SpeechRecognitionConstructor;
    expect(pickSpeechRecognitionCtor({ webkitSpeechRecognition: prefixed })).toBe(prefixed);
  });

  it("returns null when the browser has neither - the mic button hides itself", () => {
    expect(pickSpeechRecognitionCtor({})).toBeNull();
  });
});

describe("buildLiveTranscript", () => {
  it("appends the in-progress tail after settled phrases, so partial speech shows live", () => {
    const results = resultList([
      { transcript: "turn the", isFinal: true },
      { transcript: "lights on", isFinal: false },
    ]);
    expect(buildLiveTranscript(results)).toBe("turn the lights on");
  });

  it("joins multiple settled phrases with a space", () => {
    const results = resultList([
      { transcript: "what is", isFinal: true },
      { transcript: "the weather today", isFinal: true },
    ]);
    expect(buildLiveTranscript(results)).toBe("what is the weather today");
  });

  it("returns the tail alone when nothing has settled yet", () => {
    const results = resultList([{ transcript: "still talking", isFinal: false }]);
    expect(buildLiveTranscript(results)).toBe("still talking");
  });

  it("rebuilds from every result each call, not just the newest one - the whole session's text", () => {
    const firstEvent = resultList([{ transcript: "hello", isFinal: true }]);
    const secondEvent = resultList([
      { transcript: "hello", isFinal: true },
      { transcript: "world", isFinal: true },
    ]);
    expect(buildLiveTranscript(firstEvent)).toBe("hello");
    expect(buildLiveTranscript(secondEvent)).toBe("hello world");
  });
});

describe("pickLocalVoice", () => {
  const voice = (lang: string, localService: boolean, isDefault = false) =>
    ({
      lang,
      localService,
      default: isDefault,
      voiceURI: `${lang}-${localService}-${isDefault}`,
      name: lang,
    }) as SpeechSynthesisVoice;

  it("never offers a voice that runs on the vendor's servers", () => {
    expect(pickLocalVoice([voice("en-US", false), voice("en-GB", false, true)], "en-US")).toBeNull();
    expect(pickLocalVoice([], "en-US")).toBeNull();
  });

  it("prefers a local voice for the page language, then one for the same language family", () => {
    const voices = [voice("fr-FR", true), voice("en-GB", true), voice("en-US", true), voice("en-US", false)];
    expect(pickLocalVoice(voices, "en-US")).toBe(voices[2]);
    expect(pickLocalVoice(voices, "en-AU")).toBe(voices[1]);
    expect(pickLocalVoice(voices, "EN_us")?.lang).toBe("en-US");
  });

  it("falls back to the device's default local voice, then to the first local voice", () => {
    const voices = [voice("fr-FR", true), voice("de-DE", true, true), voice("en-US", false)];
    expect(pickLocalVoice(voices, "si-LK")).toBe(voices[1]);
    expect(pickLocalVoice([voice("fr-FR", true), voice("de-DE", true)], "si-LK")?.lang).toBe("fr-FR");
  });
});

describe("useSpeakText", () => {
  afterEach(() => vi.unstubAllGlobals());

  const voice = (name: string, localService: boolean) =>
    ({ name, voiceURI: name, lang: "en-US", localService, default: false }) as SpeechSynthesisVoice;

  function browserWith(voices: SpeechSynthesisVoice[]) {
    const spoken: { text: string; voice: SpeechSynthesisVoice | null; lang: string }[] = [];
    const synthesis = {
      getVoices: () => voices,
      speak: (utterance: { text: string; voice: SpeechSynthesisVoice | null; lang: string }) => spoken.push(utterance),
      cancel: vi.fn(),
    };
    vi.stubGlobal("window", { speechSynthesis: synthesis });
    vi.stubGlobal("navigator", { language: "en-US" });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        voice: SpeechSynthesisVoice | null = null;
        lang = "";
        constructor(public text: string) {}
      },
    );
    return spoken;
  }

  function hook() {
    let captured: ReturnType<typeof useSpeakText> | undefined;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    renderToStaticMarkup(
      createElement(function Probe() {
        captured = useSpeakText();
        return null;
      }),
    );
    spy.mockRestore();
    return captured!;
  }

  it("is not offered when the browser has only network voices", () => {
    browserWith([voice("Network", false)]);
    expect(hook().supported).toBe(false);
  });

  it("is not offered when the browser has no speech engine", () => {
    expect(hook().supported).toBe(false);
  });

  it("reads aloud with a voice that runs on the device, never a network one", () => {
    const spoken = browserWith([voice("Network", false), voice("Device", true)]);
    const speech = hook();
    expect(speech.supported).toBe(true);
    speech.speak("Hello there");
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toMatchObject({ text: "Hello there", lang: "en-US" });
    expect(spoken[0]?.voice?.name).toBe("Device");
  });

  it("says nothing for empty text", () => {
    const spoken = browserWith([voice("Device", true)]);
    hook().speak("   ");
    expect(spoken).toHaveLength(0);
  });
});
