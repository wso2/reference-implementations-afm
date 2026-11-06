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

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

interface SpeechRecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: { readonly transcript: string };
}

export interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface SpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognition;

interface SpeechWindow {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

export function pickSpeechRecognitionCtor(win: SpeechWindow): SpeechRecognitionConstructor | null {
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

export function buildLiveTranscript(results: SpeechRecognitionResultList): string {
  let text = "";
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result === undefined) continue;
    const chunk = result[0]?.transcript ?? "";
    text += result.isFinal ? `${chunk} ` : chunk;
  }
  return text.trim();
}

function speechWindow(): SpeechWindow {
  return window as unknown as SpeechWindow;
}

const SILENCE_TIMEOUT_MS = 5000;

export function useVoiceInput(onUpdate: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const supported = typeof window !== "undefined" && pickSpeechRecognitionCtor(speechWindow()) !== null;

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current !== null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearSilenceTimer();
      recognitionRef.current?.stop();
    };
  }, [clearSilenceTimer]);

  const start = useCallback(() => {
    const Ctor = pickSpeechRecognitionCtor(speechWindow());
    if (Ctor === null || recognitionRef.current !== null) return;
    const recognition = new Ctor();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      clearSilenceTimer();
      silenceTimerRef.current = window.setTimeout(() => recognition.stop(), SILENCE_TIMEOUT_MS);
      const transcript = buildLiveTranscript(event.results);
      if (transcript !== "") onUpdate(transcript);
    };
    recognition.onend = () => {
      clearSilenceTimer();
      recognitionRef.current = null;
      setListening(false);
    };
    recognition.onerror = () => {
      clearSilenceTimer();
      recognitionRef.current = null;
      setListening(false);
    };
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }, [onUpdate, clearSilenceTimer]);

  const stop = useCallback(() => {
    clearSilenceTimer();
    recognitionRef.current?.stop();
  }, [clearSilenceTimer]);

  return { supported, listening, start, stop };
}

const normalizedTag = (tag: string) => tag.toLowerCase().replace(/_/g, "-");
const languageFamily = (tag: string) => normalizedTag(tag).split("-")[0];

export function pickLocalVoice(voices: readonly SpeechSynthesisVoice[], language: string): SpeechSynthesisVoice | null {
  const local = voices.filter((voice) => voice.localService);
  return (
    local.find((voice) => normalizedTag(voice.lang) === normalizedTag(language)) ??
    local.find((voice) => languageFamily(voice.lang) === languageFamily(language)) ??
    local.find((voice) => voice.default) ??
    local[0] ??
    null
  );
}

function hasSpeechSynthesis(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function subscribeToVoices(onChange: () => void): () => void {
  if (!hasSpeechSynthesis() || typeof window.speechSynthesis.addEventListener !== "function") return () => {};
  window.speechSynthesis.addEventListener("voiceschanged", onChange);
  return () => window.speechSynthesis.removeEventListener("voiceschanged", onChange);
}

function localVoiceUri(): string | null {
  if (!hasSpeechSynthesis()) return null;
  return pickLocalVoice(window.speechSynthesis.getVoices(), navigator.language)?.voiceURI ?? null;
}

export function useSpeakText() {
  const [speaking, setSpeaking] = useState(false);
  const voiceUri = useSyncExternalStore(subscribeToVoices, localVoiceUri, localVoiceUri);
  const supported = voiceUri !== null;

  useEffect(() => {
    if (!supported) return;
    return () => window.speechSynthesis.cancel();
  }, [supported]);

  const speak = useCallback(
    (text: string) => {
      if (voiceUri === null || text.trim() === "") return;
      const voice = window.speechSynthesis.getVoices().find((candidate) => candidate.voiceURI === voiceUri);
      if (voice === undefined || !voice.localService) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.onend = () => setSpeaking(false);
      utterance.onerror = () => setSpeaking(false);
      setSpeaking(true);
      window.speechSynthesis.speak(utterance);
    },
    [voiceUri],
  );

  const stop = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  return { supported, speaking, speak, stop };
}
