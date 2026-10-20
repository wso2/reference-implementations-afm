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

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Icon } from "./Icon";

interface Props {
  title: string;
  onClose: () => void;
  onExpand?: () => void;
  over?: boolean;
  flush?: boolean;
  floating?: boolean;
  covered?: boolean;
  tall?: boolean;
  heading?: ReactNode;
  children: ReactNode;
}

function HeadButton({ path, label, onClick }: { path: string; label: string; onClick: () => void }) {
  return (
    <button className="u-ico" onClick={onClick} aria-label={label} data-tip={label}>
      <Icon weight={2} path={path} />
    </button>
  );
}

const EXPAND = "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7";
const CLOSE = "M18 6L6 18M6 6l12 12";

export function SidePane({
  title,
  heading,
  onClose,
  onExpand,
  over = false,
  flush = false,
  floating = false,
  covered = false,
  tall = false,
  children,
}: Props) {
  const section = useRef<HTMLElement>(null);
  const expandable = onExpand !== undefined;
  const wasExpandable = useRef(expandable);

  useEffect(() => {
    if (wasExpandable.current === expandable) return;
    wasExpandable.current = expandable;
    const active = document.activeElement;
    if (active === null || active === document.body) section.current?.focus({ preventScroll: true });
  }, [expandable]);

  return (
    <section
      className={`u-panel ${over ? "is-over panel-slide-in" : ""} ${floating ? "is-floating" : ""} ${tall ? "is-tall" : ""}`}
      aria-label={title}
      tabIndex={-1}
      inert={covered}
      ref={section}
    >
      <div className="u-panel-head">
        {heading ?? <span className="u-panel-title">{title}</span>}
        <span className="u-panel-tools">
          {onExpand !== undefined && (
            <HeadButton path={EXPAND} label="Give the conversation the whole window" onClick={onExpand} />
          )}
          <HeadButton path={CLOSE} label="Close" onClick={onClose} />
        </span>
      </div>
      {flush ? children : <div className="u-panel-body">{children}</div>}
    </section>
  );
}
