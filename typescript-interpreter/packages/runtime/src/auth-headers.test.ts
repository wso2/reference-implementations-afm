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


import { describe, expect, it } from "vitest";
import { authHeaders } from "./auth-headers";

describe("authHeaders", () => {
  it("sends a bearer token", () => {
    expect(authHeaders({ type: "bearer", token: "abc" })).toEqual({ Authorization: "Bearer abc" });
  });

  it("sends basic credentials as the base64 of user:password, encoded as UTF-8", () => {
    expect(authHeaders({ type: "basic", username: "alice", password: "s3cret" })).toEqual({ Authorization: "Basic YWxpY2U6czNjcmV0" });
    expect(authHeaders({ type: "basic", username: "zoë", password: "pässword" })).toEqual({ Authorization: `Basic ${Buffer.from("zoë:pässword").toString("base64")}` });
  });

  it("sends an api key in Authorization unless a header name is given", () => {
    expect(authHeaders({ type: "api-key", api_key: "k" })).toEqual({ Authorization: "k" });
    expect(authHeaders({ type: "api-key", api_key: "k", header_name: "X-Api-Key" })).toEqual({ "X-Api-Key": "k" });
  });

  it("reads the type without regard to case", () => {
    expect(authHeaders({ type: "BEARER", token: "abc" })).toEqual({ Authorization: "Bearer abc" });
  });

  it.each([
    ["a bearer token that is missing", { type: "bearer" }, /requires a 'token' field/],
    ["a bearer token with whitespace", { type: "bearer", token: "a b" }, /whitespace/],
    ["a bearer token with a line break", { type: "bearer", token: "a\r\nX-Injected: 1" }, /control characters/],
    ["a basic username with a colon", { type: "basic", username: "a:b", password: "p" }, /colon/],
    ["a basic password that is missing", { type: "basic", username: "a" }, /requires a 'password' field/],
    ["an api key with a line break", { type: "api-key", api_key: "k\nX: 1" }, /control characters/],
    ["an api-key header name that is not a header name", { type: "api-key", api_key: "k", header_name: "Bad Name" }, /not a valid header name/],
  ])("refuses %s", (_label, auth, message) => {
    expect(() => authHeaders(auth)).toThrow(message);
  });

  it.each(["jwt", "oauth2", "x-custom"])("says plainly that %s is not yet supported by this interpreter", (type) => {
    expect(() => authHeaders({ type })).toThrow(`'${type}' authentication is not yet supported by this interpreter`);
  });
});
