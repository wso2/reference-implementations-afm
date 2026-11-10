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

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const PAGE_SCRIPT = `
const chatPath = __PATH__;
const session = window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2);
const log = document.getElementById("log");
const form = document.getElementById("form");
const input = document.getElementById("text");
function add(who, content) {
  const item = document.createElement("li");
  item.className = who;
  item.textContent = content;
  log.appendChild(item);
  item.scrollIntoView();
  return item;
}
function detail(body) {
  try { return JSON.parse(body).detail || body; } catch (error) { return body; }
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (message === "") return;
  input.value = "";
  add("you", message);
  const item = add("agent", "...");
  try {
    const response = await fetch(chatPath, { method: "POST", headers: { "Content-Type": "text/plain", "X-Session-Id": session }, body: message });
    const body = await response.text();
    item.textContent = response.ok ? body : "Error: " + detail(body);
  } catch (error) {
    item.textContent = "Error: " + error.message;
  }
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
});
`;

const PAGE_STYLE = `
body { font: 16px system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #1c1f23; }
main { max-width: 720px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; min-height: 100vh; box-sizing: border-box; }
header { display: flex; gap: 12px; align-items: center; }
header img { width: 40px; height: 40px; border-radius: 8px; }
h1 { font-size: 20px; margin: 0; }
h1 small { font-size: 12px; font-weight: 400; color: #5b6470; }
header p { margin: 2px 0 0; color: #5b6470; font-size: 14px; }
ol { list-style: none; padding: 0; margin: 16px 0; flex: 1; display: flex; flex-direction: column; gap: 8px; }
li { padding: 10px 12px; border-radius: 10px; white-space: pre-wrap; max-width: 85%; }
li.you { align-self: flex-end; background: #1f6feb; color: #fff; }
li.agent { align-self: flex-start; background: #fff; border: 1px solid #d8dde3; }
form { display: flex; gap: 8px; }
textarea { flex: 1; font: inherit; padding: 8px; border-radius: 8px; border: 1px solid #c4cad2; resize: vertical; }
button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 0; background: #1f6feb; color: #fff; cursor: pointer; }
`;

export interface ChatPageInfo {
  name: string;
  description: string;
  version: string;
  iconUrl?: string;
  path: string;
}

export const CHAT_PAGE_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

export function chatPage({ name, description, version, iconUrl, path }: ChatPageInfo): string {
  const icon = iconUrl?.startsWith("https://") ? `<img src="${escapeHtml(iconUrl)}" alt="">` : "";
  const script = PAGE_SCRIPT.replace("__PATH__", () => JSON.stringify(path).replace(/</g, "\\u003c"));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<header>${icon}<div><h1>${escapeHtml(name)} <small>${escapeHtml(version)}</small></h1><p>${escapeHtml(description)}</p></div></header>
<ol id="log"></ol>
<form id="form"><textarea id="text" rows="2" placeholder="Type a message" required></textarea><button type="submit">Send</button></form>
</main>
<script>${script}</script>
</body>
</html>
`;
}
