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

import { useEffect, useLayoutEffect, useRef, useState } from "react";

const DELAY = 400;
const WARM = 500;
const GAP = 8;
const PEEK = 2800;

interface Shown {
  text: string;
  box: DOMRect;
}

export function Tip() {
  const [shown, setShown] = useState<Shown | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: Element | null = null;
    let timer = 0;
    let visible = false;
    let closedAt = 0;

    const hide = () => {
      window.clearTimeout(timer);
      if (visible) closedAt = Date.now();
      visible = false;
      setShown(null);
    };
    const show = (target: HTMLElement) => {
      const open = () => {
        visible = true;
        setShown({ text: target.dataset.tip ?? "", box: target.getBoundingClientRect() });
      };
      if (Date.now() - closedAt < WARM) open();
      else timer = window.setTimeout(open, DELAY);
    };
    const find = (event: Event) =>
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tip]") : null;

    const handlers: Record<string, (event: Event) => void> = {
      mouseover: (event) => {
        const next = find(event);
        if (next === current) return;
        current = next;
        hide();
        if (next !== null && window.matchMedia("(hover: hover)").matches) show(next);
      },
      mouseout: (event) => {
        if ((event as MouseEvent).relatedTarget !== null) return;
        current = null;
        hide();
      },
      focusin: (event) => {
        const next = find(event);
        current = next;
        hide();
        if (next?.matches(":focus-visible")) show(next);
      },
      keydown: (event) => {
        if ((event as KeyboardEvent).key === "Escape") hide();
      },
      click: (event) => {
        const target = find(event);
        if (target === null || target.getAttribute("aria-disabled") !== "true") return;
        if (window.matchMedia("(hover: hover)").matches) return;
        hide();
        current = target;
        visible = true;
        setShown({ text: target.dataset.tip ?? "", box: target.getBoundingClientRect() });
        timer = window.setTimeout(hide, PEEK);
      },
      focusout: hide,
      pointerdown: hide,
      scroll: hide,
    };

    for (const [name, handler] of Object.entries(handlers)) document.addEventListener(name, handler, true);
    return () => {
      window.clearTimeout(timer);
      for (const [name, handler] of Object.entries(handlers)) document.removeEventListener(name, handler, true);
    };
  }, []);

  useLayoutEffect(() => {
    const el = bubble.current;
    if (el === null || shown === null) return;
    const { width, height } = el.getBoundingClientRect();
    const { box } = shown;
    const left = box.left + box.width / 2 - width / 2;
    const below = box.bottom + GAP + height <= window.innerHeight;
    el.style.left = `${Math.min(Math.max(left, GAP), window.innerWidth - width - GAP)}px`;
    el.style.top = `${below ? box.bottom + GAP : box.top - GAP - height}px`;
  }, [shown]);

  return shown === null ? null : (
    <div ref={bubble} className="tip" role="tooltip">
      {shown.text}
    </div>
  );
}
