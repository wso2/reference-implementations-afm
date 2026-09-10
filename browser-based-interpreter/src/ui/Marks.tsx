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

import { useState } from "react";
import { agentInitial } from "../core/chat/chat-text";
import { serverIcon } from "../core/mcp/mcp-servers";
import { Icon } from "./Icon";

export function markColour(name: string): string {
  const palette = ["#2B2B2B", "#0B6E4F", "#8E6210", "#7A50C8", "#AE3A2E", "#1E7A55"];
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) % 997;
  return palette[hash % palette.length] as string;
}

export function providerColour(provider: string): string {
  if (provider === "openai") return "#10A37F";
  if (provider === "anthropic") return "#C15F3C";
  return "var(--accent)";
}

export function NameMark({
  name,
  seed = name,
  large = false,
  fallback = "?",
}: {
  name: string;
  seed?: string;
  large?: boolean;
  fallback?: string;
}) {
  return (
    <span className={large ? "u-mk lg" : "u-mk"} style={{ background: markColour(seed) }}>
      {name.trim().charAt(0).toUpperCase() || fallback}
    </span>
  );
}

export function ServerMark({
  url,
  name,
  seed = name,
  large = false,
}: {
  url: string | undefined;
  name: string;
  seed?: string;
  large?: boolean;
}) {
  const [failed, setFailed] = useState<string>();
  const icon = serverIcon(url);
  if (icon === undefined || icon === failed) return <NameMark name={name} seed={seed} large={large} />;
  return (
    <img
      className={large ? "u-mk u-mk-img lg" : "u-mk u-mk-img"}
      src={icon}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(icon)}
    />
  );
}

export function ProviderBadge({ provider }: { provider: string }) {
  return (
    <span className="u-mk" style={{ background: providerColour(provider) }}>
      <ProviderMark provider={provider} size={14} />
    </span>
  );
}

export function ProviderMark({ provider, size = 16 }: { provider: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true as const };

  if (provider === "openai") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M21.6 9.8a5.9 5.9 0 00-.5-4.9 6 6 0 00-6.4-2.9A5.9 5.9 0 0010.3 0 6 6 0 004.6 4.1a5.9 5.9 0 00-4 2.9 6 6 0 00.8 7A5.9 5.9 0 002 18.8a6 6 0 006.4 2.9A5.9 5.9 0 0013.7 24a6 6 0 005.7-4.1 5.9 5.9 0 004-2.9 6 6 0 00-.8-7zm-8.9 12.4a4.4 4.4 0 01-2.8-1l.1-.1 4.7-2.7a.8.8 0 00.4-.7v-6.6l2 1.1v5.5a4.5 4.5 0 01-4.4 4.5zM3.3 18a4.4 4.4 0 01-.5-3l.1.1 4.7 2.7a.8.8 0 00.8 0l5.7-3.3v2.3l-4.8 2.8a4.5 4.5 0 01-6-1.6zM2 7.7a4.4 4.4 0 012.3-2v5.6a.8.8 0 00.4.7l5.7 3.3-2 1.1-4.8-2.7A4.5 4.5 0 012 7.7zm16.4 3.8L12.7 8.2l2-1.1 4.8 2.8a4.5 4.5 0 01-.7 8.1v-5.7a.8.8 0 00-.4-.8zm2-3l-.1-.1-4.7-2.7a.8.8 0 00-.8 0L9.1 9v-2.3l4.8-2.8a4.5 4.5 0 016.5 4.6zM8 12.6l-2-1.1V6a4.5 4.5 0 017.4-3.4l-.1.1-4.7 2.7a.8.8 0 00-.4.7zm1.1-2.4L11.7 8.7l2.6 1.5v3L11.7 14.7l-2.6-1.5z" />
      </svg>
    );
  }

  if (provider === "anthropic") {
    return (
      <svg {...common} fill="currentColor">
        <path d="M14.6 3.5h-3l5.4 17h3zM6.4 3.5L1 20.5h3.1l1.1-3.6h5.7l1.1 3.6h3.1L9.7 3.5zm-.4 10.6l1.9-6 1.9 6z" />
      </svg>
    );
  }

  return (
    <Icon
      size={size}
      path="M12 4a4 4 0 00-4 4 3 3 0 00-1 5.8V17a3 3 0 003 3h4a3 3 0 003-3v-3.2A3 3 0 0016 8a4 4 0 00-4-4z"
    />
  );
}

export function iconUrlError(value: string): string | null {
  let protocol = "";
  try {
    protocol = new URL(value.trim()).protocol;
  } catch {
    return "Paste a full link that starts with https://";
  }
  return protocol === "https:" ? null : "Use a link that starts with https://";
}

export function AgentAvatar({ name, iconUrl = "", className }: { name: string; iconUrl?: string; className: string }) {
  const [failedUrl, setFailedUrl] = useState("");
  const show = iconUrl !== "" && iconUrl !== failedUrl && iconUrlError(iconUrl) === null;
  return (
    <span className={show ? `${className} has-img` : className} aria-hidden="true">
      {show ? (
        <img src={iconUrl} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(iconUrl)} />
      ) : (
        agentInitial(name)
      )}
    </span>
  );
}
