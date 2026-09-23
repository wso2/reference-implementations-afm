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

import { useEffect, useState } from "react";

export interface TipTarget {
  title: string;
  body: string;
  at: { top: number; left: number; height: number };
}

export function ToolTip({ tip }: { tip: TipTarget | null }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (tip === null) {
      setShown(false);
      return;
    }
    const id = window.requestAnimationFrame(() => setShown(true));
    return () => window.cancelAnimationFrame(id);
  }, [tip]);

  if (tip === null) return null;

  return (
    <div className={`tool-tip ${shown ? "is-shown" : ""}`} role="tooltip" style={tipPosition(tip)}>
      <span className="tool-tip-title">{tip.title}</span>
      <span className="tool-tip-body">{shorten(tip.body)}</span>
    </div>
  );
}

export function tipFor(title: string, body: string, box: DOMRectLike): TipTarget {
  return { title, body, at: { top: box.top, left: box.left, height: box.height } };
}

interface DOMRectLike {
  top: number;
  left: number;
  height: number;
}

const TIP_LIMIT = 260;

export function shorten(text: string, limit = TIP_LIMIT): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:\s]+$/, "")}…`;
}

export function tipPosition(tip: TipTarget): { top: number; left: number } {
  return { top: tip.at.top + tip.at.height / 2, left: tip.at.left - 12 };
}
