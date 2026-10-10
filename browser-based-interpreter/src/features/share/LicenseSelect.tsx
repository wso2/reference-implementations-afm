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

import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { LICENSES } from "../../core/agent/catalogs";
import { Icon } from "../../ui/Icon";

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

const NOT_SET = { id: "", note: "Leave the license out" };

export function LicenseSelect({ value, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const options =
    value === "" || LICENSES.some((license) => license.id === value)
      ? [NOT_SET, ...LICENSES]
      : [NOT_SET, { id: value, note: "From the file" }, ...LICENSES];

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();

    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && root.current?.contains(event.target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
      toggle.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    if (items.length === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    items[(items.indexOf(document.activeElement as HTMLElement) + step + items.length) % items.length]?.focus();
  }

  function pick(id: string) {
    onChange(id);
    setOpen(false);
    toggle.current?.focus();
  }

  return (
    <div className="u-select" ref={root} onKeyDown={onKeyDown}>
      <button
        ref={toggle}
        className="u-ghost u-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="License"
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span className={value === "" ? "u-select-empty" : ""}>{value === "" ? "Not set" : value}</span>
        <Icon weight={2.2} path="M6 9l6 6 6-6" />
      </button>
      {open && (
        <div className="u-select-menu" role="listbox" aria-label="License">
          {options.map((option) => (
            <button
              key={option.id}
              className="u-select-opt"
              role="option"
              aria-selected={option.id === value}
              onClick={() => pick(option.id)}
            >
              <span>
                <span className="u-select-name">{option.id === "" ? "Not set" : option.id}</span>
                <span className="u-select-note">{option.note}</span>
              </span>
              <Icon className="u-select-check" weight={2.4} path="M5 12.5l4.5 4.5L19 7.5" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
