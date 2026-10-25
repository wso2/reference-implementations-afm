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
import { useDismiss } from "./hooks";

interface Choice {
  label: string;
  onPick: () => void;
}

interface Props {
  title: string;
  text: string;
  secondary: Choice;
  primary: Choice;
  focus: "secondary" | "primary";
  onDismiss: () => void;
  wrap: RefObject<HTMLElement | null>;
  align?: "start" | "end";
}

export function ConfirmNote({ title, text, secondary, primary, focus, onDismiss, wrap, align = "start" }: Props) {
  const box = useRef<HTMLDivElement>(null);
  useDismiss(true, wrap, onDismiss);

  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>(focus === "primary" ? ".primary" : ".ghost")?.focus();
  }, [focus]);

  return (
    <div className={`u-confirm${align === "end" ? " is-end" : ""}`} role="dialog" aria-label={title} ref={box}>
      <b>{title}</b>
      <p>{text}</p>
      <div className="u-confirm-actions">
        <button className="u-btn ghost sm" onClick={secondary.onPick}>
          {secondary.label}
        </button>
        <button className="u-btn primary sm" onClick={primary.onPick}>
          {primary.label}
        </button>
      </div>
    </div>
  );
}
