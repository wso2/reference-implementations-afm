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

import { type ComponentPropsWithoutRef, useRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useCopyFeedback } from "../../ui/hooks";

function PreBlock(props: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const { copied, copy } = useCopyFeedback();

  return (
    <div className="code-wrap">
      <button className="code-copy" onClick={() => copy(ref.current?.innerText ?? "")} title="Copy code">
        {copied ? "Copied" : "Copy"}
      </button>
      <pre ref={ref} {...props} />
    </div>
  );
}

function BlockedImage(props: ComponentPropsWithoutRef<"img">) {
  const src = typeof props.src === "string" ? props.src : "";
  let host = "";
  try {
    host = new URL(src, window.location.href).host;
  } catch {
    host = "";
  }
  const label = typeof props.alt === "string" && props.alt !== "" ? props.alt : "image";

  return (
    <span className="md-img-blocked" title={src}>
      <span aria-hidden="true">🚫</span>
      {label}
      {host !== "" && <span className="md-img-host">{host}</span>}
    </span>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a(props) {
            return (
              <a href={props.href} target="_blank" rel="noopener noreferrer">
                {props.children}
              </a>
            );
          },
          pre: PreBlock,
          img: BlockedImage,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
