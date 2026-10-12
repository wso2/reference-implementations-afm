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

import { useEffect, useRef, useState } from "react";
import {
  type AgentActivity,
  type Leg,
  LEG_MS,
  legAfter,
  type PhasePoint,
  reportedActivity,
} from "../../core/chat/agent-activity";
import { type ChatState } from "../../core/chat/chat-state";
import { displayName } from "../../core/setup/setup-check";
import { START_TITLES } from "../start/start-flow";

export type SidePanel = "chat" | "model" | "tools" | "share" | "settings" | "info" | "setup";

type LeftPanel = "agents" | "start";

const SIDE_TITLE: Record<SidePanel, string> = {
  chat: "Chat",
  model: "Model",
  tools: "Connect tools",
  share: "Share",
  settings: "Settings",
  info: "About",
  setup: "Setup",
};

export function chatCloseAction(fullWindow: boolean, phone: boolean): "shrink" | "close" {
  return fullWindow && !phone ? "shrink" : "close";
}

export function sideTitle(panel: SidePanel, editingServer: string | null): string {
  return panel === "tools" && editingServer !== null ? displayName(editingServer) : SIDE_TITLE[panel];
}

export const LEFT_TITLE: Record<LeftPanel, string> = {
  agents: "Agents",
  start: START_TITLES.menu,
};

export interface SideState {
  open: SidePanel | null;
  under: SidePanel[];
}

export const NOTHING_OPEN: SideState = { open: null, under: [] };

const WORKING_SURFACES: readonly SidePanel[] = ["chat"];

export function openPanel(state: SideState, next: SidePanel): SideState {
  if (WORKING_SURFACES.includes(next)) return { open: next, under: [] };
  const over = state.open !== null && WORKING_SURFACES.includes(state.open) ? [state.open] : state.under;
  return { open: next, under: over };
}

export function openOver(state: SideState, next: SidePanel): SideState {
  return state.open === null ? { open: next, under: [] } : { open: next, under: [...state.under, state.open] };
}

export function closePanel(state: SideState): SideState {
  const below = state.under[state.under.length - 1];
  return below === undefined ? NOTHING_OPEN : { open: below, under: state.under.slice(0, -1) };
}

export function togglePanel(state: SideState, next: SidePanel): SideState {
  return state.open === next ? closePanel(state) : openPanel(state, next);
}

export function useAgentActivity(state: ChatState): AgentActivity {
  const reported = reportedActivity(state, state.tools);
  const [leg, setLeg] = useState<Leg | null>(null);
  const previous = useRef<PhasePoint>({ phase: "idle" });

  const userCount = state.messages.filter((message) => message.kind === "user").length;
  const seenUserCount = useRef(userCount);
  const { phase, serverId } = reported;

  useEffect(() => {
    const next = legAfter(previous.current, { phase, serverId }, userCount > seenUserCount.current);
    previous.current = { phase, serverId };
    seenUserCount.current = userCount;
    if (next === null) return;

    setLeg(next);
    const timer = window.setTimeout(() => setLeg(null), LEG_MS[next.phase]);
    return () => window.clearTimeout(timer);
  }, [phase, serverId, userCount]);

  const running = state.status === "streaming" || state.status === "connecting";
  if (leg !== null && running) return { ...reported, phase: leg.phase, serverId: leg.serverId };
  return reported;
}

export function usePanels(initial: { chat: boolean; start: boolean }, compact: boolean) {
  const [nav, setNav] = useState<SideState>(() => (initial.chat ? { open: "chat", under: [] } : NOTHING_OPEN));
  const [left, setLeft] = useState<LeftPanel | null>(() => (initial.start ? "start" : null));
  const [chatFull, setChatFull] = useState(initial.chat);

  function show(next: SideState) {
    setNav(next);
    if (next.open !== "chat") setChatFull(false);
  }

  function reveal(next: SideState) {
    setLeft(null);
    show(next);
  }

  const closeSide = () => show(NOTHING_OPEN);

  return {
    nav,
    side: nav.open,
    backToSetup: nav.under[nav.under.length - 1] === "setup",
    left,
    setLeft,
    chatFull,
    setChatFull,
    reveal,
    openSide: (next: SidePanel) => reveal(openPanel(nav, next)),
    toggleSide: (next: SidePanel) => {
      const toggled = togglePanel(nav, next);
      if (toggled.open === next) reveal(toggled);
      else show(toggled);
    },
    leavePanel: () => show(closePanel(nav)),
    closeSide,
    openLeft: (next: LeftPanel) => {
      setLeft(next);
      setChatFull(false);
    },
    toggleLeft: (next: LeftPanel) => {
      if (left === next) setLeft(null);
      else {
        setLeft(next);
        setChatFull(false);
      }
    },
    closeLeft: () => setLeft(null),
    closeChat: () => (chatCloseAction(chatFull, compact) === "shrink" ? setChatFull(false) : closeSide()),
  };
}
