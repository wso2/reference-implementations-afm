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

import { TEXT_SIGNATURE } from "@afm/engine";
import { describe, expect, it } from "vitest";
import { chooseInterfaces, pathOf } from "./interfaces";

const metadata = (interfaces?: unknown[]) => ({ interfaces }) as never;
const text = { input: { type: "string" }, output: { type: "string" } };
const consolechat = { type: "consolechat", signature: text };
const webchat = (path?: string) => ({ type: "webchat", signature: text, exposure: { http: { path: path ?? "/chat" } } });
const webhook = (path?: string) => ({ type: "webhook", exposure: { http: { path: path ?? "/webhook" } } });

describe("chooseInterfaces", () => {
  it("falls back to console chat when the file names no interface", () => {
    expect(chooseInterfaces(metadata())).toEqual({ console: { signature: TEXT_SIGNATURE } });
    expect(chooseInterfaces(metadata([]))).toEqual({ console: { signature: TEXT_SIGNATURE } });
  });

  it("picks exactly the interfaces the file names", () => {
    expect(chooseInterfaces(metadata([consolechat]))).toEqual({ console: consolechat });
    const web = chooseInterfaces(metadata([webchat()]));
    expect(web.console).toBeUndefined();
    expect(web.webchat).toBeDefined();
    expect(web.webhook).toBeUndefined();
    const all = chooseInterfaces(metadata([consolechat, webchat(), webhook()]));
    expect([all.console !== undefined, all.webchat !== undefined, all.webhook !== undefined]).toEqual([true, true, true]);
  });

  it("refuses platformchat, saying it is not yet supported", () => {
    expect(() => chooseInterfaces(metadata([{ type: "platformchat" }]))).toThrow("The 'platformchat' interface is not yet supported by this interpreter.");
  });

  it("accepts structured input and output, and keeps the signature for the interface to use", () => {
    const structured = { input: { type: "object", properties: { city: { type: "string" } } }, output: { type: "object" } };
    expect(chooseInterfaces(metadata([{ ...consolechat, signature: structured }])).console?.signature).toEqual(structured);
    expect(chooseInterfaces(metadata([{ ...webchat(), signature: structured }])).webchat?.signature).toEqual(structured);
    expect(() => chooseInterfaces(metadata([{ ...webhook(), signature: { input: { type: "object" } } }]))).not.toThrow();
  });

  it("refuses a schema it cannot use, naming the side and the interface", () => {
    const broken = { input: { type: "nonsense" }, output: { type: "string" } };
    expect(() => chooseInterfaces(metadata([{ ...webchat(), signature: broken }]))).toThrow("The input schema of the webchat interface is not valid");
    expect(() => chooseInterfaces(metadata([{ ...consolechat, signature: { input: { type: "string" }, output: { type: "nonsense" } } }]))).toThrow("The output schema of the consolechat interface is not valid");
  });

  it("refuses two interfaces of one kind", () => {
    for (const twice of [[consolechat, consolechat], [webchat(), webchat("/other")], [webhook(), webhook("/other")]]) {
      expect(() => chooseInterfaces(metadata(twice))).toThrow("Multiple consolechat, webchat, or webhook interfaces are not supported.");
    }
  });

  it("refuses one path used by web chat and a webhook", () => {
    expect(() => chooseInterfaces(metadata([webchat("/events"), webhook("/events")]))).toThrow("The HTTP path '/events' is used by both webchat and webhook.");
  });

  it("refuses a path that is reserved, or that does not start with a slash", () => {
    for (const path of ["/", "/health", "/chat/ui"]) {
      expect(() => chooseInterfaces(metadata([webchat(path)]))).toThrow(`The HTTP path '${path}' of the webchat interface is reserved.`);
      expect(() => chooseInterfaces(metadata([webhook(path)]))).toThrow(`The HTTP path '${path}' of the webhook interface is reserved.`);
    }
    expect(() => chooseInterfaces(metadata([webchat("chat")]))).toThrow("must start with '/'");
  });

  it("gives each web interface its own default path", () => {
    const chosen = chooseInterfaces(metadata([{ type: "webchat", signature: text, exposure: { http: {} } }, { type: "webhook", exposure: { http: {} } }]));
    expect([pathOf(chosen.webchat!), pathOf(chosen.webhook!)]).toEqual(["/chat", "/webhook"]);
  });
});
