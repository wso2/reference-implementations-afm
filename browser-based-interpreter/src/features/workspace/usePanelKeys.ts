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

import { type RefObject, useEffect, useRef } from "react";

type EscapeScope = "left" | "side" | "other" | "typing";

type PanelTarget = "left" | "over" | "chat";

export interface PanelsOpen {
  left: boolean;
  side: boolean;
  over: boolean;
}

interface PanelSpot {
  top: string | null;
  depth: number;
}

type FocusMove = "enter" | "swap" | "leave" | "none";

const TYPING =
  'input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="reset"]), textarea, select, [contenteditable]:not([contenteditable="false"])';

const OWN_ESCAPE = ".u-confirm, .u-focus, .u-pill-pop";

function scopeOf(target: Element | null, left: Element | null, side: Element | null): EscapeScope {
  if (target === null || target === document.body || target === document.documentElement) return "other";
  const inLeft = left?.contains(target) === true;
  const inSide = side?.contains(target) === true;
  if (target instanceof HTMLInputElement && target.type === "search" && target.value !== "") return "typing";
  if (!inLeft && !inSide && target.closest(TYPING) !== null) return "typing";
  return inLeft ? "left" : inSide ? "side" : "other";
}

export function usePanelEscape(
  left: RefObject<HTMLElement | null>,
  side: RefObject<HTMLElement | null>,
  open: PanelsOpen,
  close: Record<PanelTarget, () => void>,
): void {
  const latest = useRef({ open, close });
  latest.current = { open, close };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (document.querySelector(OWN_ESCAPE) !== null) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".xc-edit-field")) return;
      const next = panelToClose(scopeOf(target, left.current, side.current), latest.current.open);
      if (next === null) return;
      event.preventDefault();
      latest.current.close[next]();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [left, side]);
}

export function usePanelFocus(region: RefObject<HTMLElement | null>, top: string | null, depth: number): void {
  const last = useRef<PanelSpot>({ top, depth });
  const openers = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const before = last.current;
    last.current = { top, depth };
    const move = focusMove(before, { top, depth });
    const root = region.current;
    if (root === null || move === "none") return;
    const active = document.activeElement;
    const lost = !(active instanceof HTMLElement) || active === document.body || root.contains(active);

    if (move === "leave") {
      let back: HTMLElement | null = null;
      for (let level = before.depth; level > depth && back === null; level -= 1) {
        const candidate = openers.current[level] ?? null;
        if (candidate?.isConnected === true) back = candidate;
      }
      openers.current.length = depth + 1;
      if (lost) back?.focus({ preventScroll: true });
      return;
    }

    const panel = root.querySelector<HTMLElement>(".u-panel.is-over") ?? root.querySelector<HTMLElement>(".u-panel");
    if (panel === null) return;
    const opener = active instanceof HTMLElement && active !== document.body && !panel.contains(active) ? active : null;
    openers.current[depth] = opener;
    openers.current.length = depth + 1;
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
  }, [region, top, depth]);
}

export function panelToClose(scope: EscapeScope, open: PanelsOpen): PanelTarget | null {
  if (scope === "typing") return null;
  const side: PanelTarget | null = !open.side ? null : open.over ? "over" : "chat";
  if (scope === "left") return open.left ? "left" : null;
  if (scope === "side") return side;
  return side ?? (open.left ? "left" : null);
}

export function focusMove(before: PanelSpot, after: PanelSpot): FocusMove {
  if (after.depth > before.depth) return "enter";
  if (after.depth < before.depth) return "leave";
  return after.top !== before.top ? "swap" : "none";
}
