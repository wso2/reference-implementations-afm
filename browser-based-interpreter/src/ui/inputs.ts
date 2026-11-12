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

export const HIDDEN_FILE_INPUT = {
  className: "visually-hidden",
  tabIndex: -1,
  "aria-hidden": true,
} as const;

export const SECRET_INPUT = {
  autoComplete: "new-password",
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
} as const;

// Enter sends and Shift+Enter adds a line. The Enter that confirms a word being composed (an IME) does neither.
export function sendsOnEnter(event: { key: string; shiftKey: boolean; nativeEvent: { isComposing: boolean } }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing;
}
