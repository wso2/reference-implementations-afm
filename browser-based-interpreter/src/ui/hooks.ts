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

import { type RefObject, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function useDismiss(active: boolean, wrap: RefObject<HTMLElement | null>, onDismiss: () => void): void {
  const dismiss = useEffectEvent(onDismiss);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || wrap.current?.contains(event.target) === true) return;
      dismiss();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [active, wrap]);
}

export function useSettled<T>(value: T, delayMs = 300): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    if (Object.is(value, settled)) return;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, settled, delayMs]);

  return settled;
}

export function useCopyFeedback(ms = 1200) {
  const [copied, setCopied] = useState(false);

  function copy(text: string) {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), ms);
      },
      () => {},
    );
  }

  return { copied, copy };
}

export const LEAVE_MS = 560;

export function useLingering<T>(items: readonly T[]): { items: readonly T[]; leaving: boolean } {
  const [kept, setKept] = useState<readonly T[]>(items);

  useEffect(() => {
    if (items.length > 0) {
      setKept(items);
      return;
    }
    const timer = window.setTimeout(() => setKept(items), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [items]);

  return { items: kept, leaving: items.length === 0 && kept.length > 0 };
}

export function useAutosize(value: string, maxHeight: number) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const field = ref.current;
    if (field === null) return;
    const observer = new ResizeObserver(() => setWidth(field.clientWidth));
    observer.observe(field);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const field = ref.current;
    if (field === null) return;
    field.style.height = "auto";
    const height = grownHeight(field.clientWidth, field.scrollHeight, maxHeight);
    if (height !== null) field.style.height = `${height}px`;
  }, [value, width, maxHeight]);

  return ref;
}

export function grownHeight(clientWidth: number, scrollHeight: number, maxHeight: number): number | null {
  if (clientWidth <= 0) return null;
  return Math.min(scrollHeight, maxHeight);
}

interface RunTracker {
  begin(key: string): number;
  isCurrent(key: string, run: number): boolean;
  reset(): void;
}

export function createRunTracker(): RunTracker {
  let counter = 0;
  const latest = new Map<string, number>();
  return {
    begin(key) {
      counter += 1;
      latest.set(key, counter);
      return counter;
    },
    isCurrent: (key, run) => latest.get(key) === run,
    reset: () => latest.clear(),
  };
}

export function useRunTracker(): RunTracker {
  return useState(createRunTracker)[0];
}

// While a dialog is open, the page behind it cannot be reached with the keyboard or a screen reader,
// and the focus goes back to where it was when the dialog closes.
export function useModalPage(): void {
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const page = document.getElementById("root");
    page?.setAttribute("inert", "");
    return () => {
      page?.removeAttribute("inert");
      if (before !== null && before.isConnected) before.focus();
    };
  }, []);
}

// Runs one task after another. A task that fails does not stop the ones behind it.
export function createSerialQueue(): (task: () => Promise<void>) => void {
  let tail: Promise<void> = Promise.resolve();
  return (task) => {
    tail = tail.then(task).catch(() => {});
  };
}
