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

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]';

interface Props {
  title: string;
  subtitle?: string;
  footer: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  narrow?: boolean;
  tall?: boolean;
  sheet?: boolean;
  focusKey: string;
  onBack?: () => void;
  onClose?: () => void;
  onEscape: () => void;
  onOutside?: () => void;
  children: ReactNode;
}

export function DialogFrame({
  title,
  subtitle,
  footer,
  icon,
  actions,
  narrow = false,
  tall = false,
  sheet = false,
  focusKey,
  onBack,
  onClose,
  onEscape,
  onOutside,
  children,
}: Props) {
  const titleId = useId();
  const subtitleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const escape = useRef(onEscape);
  escape.current = onEscape;

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const page = document.getElementById("root");
    page?.setAttribute("inert", "");
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      escape.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      page?.removeAttribute("inert");
      if (before !== null && before.isConnected) before.focus();
    };
  }, []);

  useEffect(() => {
    const root = panel.current;
    if (root === null) return;
    const target =
      root.querySelector<HTMLElement>("[data-autofocus]") ??
      root.querySelector(".u-dlg-body")?.querySelector<HTMLElement>(FOCUSABLE);
    (target ?? root).focus();
  }, [focusKey]);

  const dialog = (
    <div
      className={sheet ? "u-dlg-scrim is-sheet" : "u-dlg-scrim"}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOutside?.();
      }}
    >
      <div
        ref={panel}
        className={["u-dlg", narrow ? "narrow" : "", tall ? "tall" : ""].filter((name) => name !== "").join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle === undefined ? undefined : subtitleId}
        tabIndex={-1}
      >
        <div className="u-dlg-head">
          <div>
            {onBack !== undefined && (
              <button className="u-dlg-back" onClick={onBack}>
                <Icon path="M19 12H5M12 19l-7-7 7-7" size={14} />
                Back
              </button>
            )}
            <div className={icon === undefined ? undefined : "u-dlg-id"}>
              {icon !== undefined && (
                <span className="u-dlg-tile" aria-hidden="true">
                  {icon}
                </span>
              )}
              <div>
                <h3 className="u-dlg-title" id={titleId}>
                  {title}
                </h3>
                {subtitle !== undefined && (
                  <p className="u-dlg-sub" id={subtitleId}>
                    {subtitle}
                  </p>
                )}
              </div>
            </div>
          </div>
          {onClose !== undefined && (
            <button className="u-dlg-x" aria-label="Close" onClick={onClose}>
              <Icon path="M18 6L6 18M6 6l12 12" size={16} />
            </button>
          )}
        </div>
        <div className="u-dlg-body">{children}</div>
        {actions === undefined ? (
          <p className="u-dlg-foot">{footer}</p>
        ) : (
          <div className="u-dlg-foot act">
            <span>{footer}</span>
            <span className="btns">{actions}</span>
          </div>
        )}
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
