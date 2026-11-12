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
import { signInProblems, withoutSignIns } from "./sign-in";

const signIn = {
  type: "oauth2",
  grant_type: "authorization_code",
  authorize_url: "https://auth.example.com/authorize",
  token_url: "https://auth.example.com/token",
  client_id: "id",
};

const withServers = (...servers: unknown[]) => ({ name: "A", tools: { mcp: servers } });
const http = (authentication?: unknown) => ({ name: "s", transport: { type: "http", url: "https://s.example.com/mcp", ...(authentication === undefined ? {} : { authentication }) } });

describe("withoutSignIns", () => {
  it("takes a sign-in block out of its server and hands it back with the server's place and name", () => {
    const { frontmatter, signIns } = withoutSignIns(withServers(http({ type: "bearer", token: "t" }), http(signIn)));
    expect(signIns).toEqual([{ index: 1, name: "s", auth: signIn }]);
    expect(frontmatter).toEqual(withServers(http({ type: "bearer", token: "t" }), http()));
  });

  it("recognises the type and the grant in any letter case", () => {
    expect(withoutSignIns(withServers(http({ ...signIn, type: "OAuth2", grant_type: "Authorization_Code" }))).signIns).toHaveLength(1);
  });

  it("leaves other oauth2 grants to the interpreter", () => {
    const grant = { type: "oauth2", grant_type: "client_credentials", token_url: "https://t" };
    expect(withoutSignIns(withServers(http(grant))).signIns).toEqual([]);
  });

  it("does not touch the model, a stdio server, or a file with no tools", () => {
    const stdio = { name: "s", transport: { type: "stdio", command: "node", authentication: signIn } };
    expect(withoutSignIns(withServers(stdio)).signIns).toEqual([]);
    const bare = { name: "A", model: { authentication: signIn } };
    expect(withoutSignIns(bare)).toEqual({ frontmatter: bare, signIns: [] });
  });

  it("does not change the file it was given", () => {
    const source = withServers(http(signIn));
    const copy = structuredClone(source);
    withoutSignIns(source);
    expect(source).toEqual(copy);
  });
});

describe("signInProblems", () => {
  const problems = (block: Record<string, unknown>) => signInProblems([{ index: 2, name: "s", auth: block }]).map((problem) => problem.message);

  it("accepts a complete block, with or without scopes, and addresses that are still variables", () => {
    expect(problems(signIn)).toEqual([]);
    expect(problems({ ...signIn, scopes: ["a"] })).toEqual([]);
    expect(problems({ ...signIn, authorize_url: "${env:AUTH}", token_url: "${env:TOKEN}" })).toEqual([]);
  });

  it("says where the block is", () => {
    expect(signInProblems([{ index: 2, name: "s", auth: { type: "oauth2", grant_type: "authorization_code" } }])[0]?.path).toEqual(["tools", "mcp", 2, "transport", "authentication"]);
  });

  it("names every missing field", () => {
    expect(problems({ type: "oauth2", grant_type: "authorization_code" })).toEqual(["oauth2 grant_type 'authorization_code' requires 'authorize_url', 'token_url', 'client_id' fields"]);
  });

  it("refuses a field the sign-in does not use, such as a client secret", () => {
    expect(problems({ ...signIn, client_secret: "s" })).toEqual(["oauth2 grant_type 'authorization_code' does not support 'client_secret' field"]);
  });

  it.each([
    ["authorize_url", "/relative", "authentication.authorize_url must be an absolute http:// or https:// URL"],
    ["token_url", "ftp://auth.example.com/token", "authentication.token_url must be an http:// or https:// URL - got 'ftp://'"],
    ["token_url", 5, "authentication.token_url must be text"],
    ["client_id", 5, "authentication.client_id must be text"],
    ["scopes", "read", "authentication.scopes must be a list of text"],
    ["scopes", ["a", 2], "authentication.scopes must be a list of text"],
  ])("refuses %s set to %j", (field, value, message) => {
    expect(problems({ ...signIn, [field]: value })).toEqual([message]);
  });
});
