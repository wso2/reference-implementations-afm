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

import { useRef } from "react";
import type { UIEvent } from "react";
import { highlightAfm } from "./afm-highlight";
import type { Token } from "./afm-highlight";

interface Props {
  value: string;
  onChange: (value: string) => void;
  errorLines?: ReadonlySet<number>;
}

function tokenLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "plain" && token.text === "\n") {
      lines.push([]);
      continue;
    }
    lines[lines.length - 1]!.push(token);
  }
  return lines;
}

export function CodeEditor({ value, onChange, errorLines }: Props) {
  const viewRef = useRef<HTMLPreElement>(null);
  const tokens = highlightAfm(value);
  const codeLines = tokenLines(tokens);

  function syncScroll(event: UIEvent<HTMLTextAreaElement>) {
    const view = viewRef.current;
    if (view === null) return;
    view.scrollTop = event.currentTarget.scrollTop;
    view.scrollLeft = event.currentTarget.scrollLeft;
  }

  return (
    <div className="code-editor u-raw">
      <pre className="code-editor-face code-editor-view" ref={viewRef} aria-hidden="true">
        {codeLines.map((lineTokens, index) => (
          <span
            className={`code-editor-line ${errorLines?.has(index + 1) === true ? "is-error-line" : ""}`}
            key={index}
          >
            {lineTokens.map((token, tokenIndex) => (
              <span className={`syn-${token.kind}`} key={tokenIndex}>
                {token.text}
              </span>
            ))}
          </span>
        ))}
      </pre>
      <textarea
        className="code-editor-face code-editor-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Agent file source"
      />
    </div>
  );
}
