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
import { type SignInOutcome } from "../core/oauth/oauth-signin";
import { type OAuthProviderRef } from "../core/oauth/session";
import type { ClientMessage, ProbeResult, ServerMessage } from "../core/runtime/protocol";
import { WorkerLink } from "./worker-link";

export function useAgentWorker(onMessage: (message: ServerMessage) => void) {
  const latestOnMessage = useRef(onMessage);
  latestOnMessage.current = onMessage;
  const linkRef = useRef<WorkerLink | null>(null);
  linkRef.current ??= new WorkerLink((message) => latestOnMessage.current(message));
  const link = linkRef.current;

  useEffect(() => {
    link.start();
    return () => link.stop();
  }, [link]);

  return {
    post: (message: ClientMessage): void => link.post(message),
    probe: (buildMessage: (id: string) => ClientMessage): Promise<ProbeResult> => link.probe(buildMessage),
    startOAuthSignIn: (provider: OAuthProviderRef): Promise<SignInOutcome> => link.startOAuthSignIn(provider),
  };
}
