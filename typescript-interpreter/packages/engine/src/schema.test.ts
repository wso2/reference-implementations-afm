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
import { AfmValidationError } from "./errors";
import { jsonSchema, validateMetadata } from "./schema";

describe("validateMetadata", () => {
  it("reads a number written as text once its variable is resolved", () => {
    expect(validateMetadata({ max_iterations: "7" }).max_iterations).toBe(7);
  });

  it("leaves a number written as a variable unchecked until it is resolved", () => {
    expect(validateMetadata({ max_iterations: "${env:STEPS}" }).max_iterations).toBeUndefined();
    expect(() => validateMetadata({ max_iterations: "before-${env:STEPS}" })).toThrow(AfmValidationError);
  });

  it("accepts valid metadata and returns typed data", () => {
    const md = validateMetadata({
      name: "Test",
      max_iterations: 5,
      model: { provider: "openai", authentication: { type: "bearer", token: "t" } },
      interfaces: [{ type: "webchat" }],
      tools: { mcp: [{ name: "s", transport: { type: "http", url: "https://x/y" } }] },
    });
    expect(md.name).toBe("Test");
    expect(md.max_iterations).toBe(5);
    expect(md.interfaces?.[0]?.type).toBe("webchat");
  });

  it("rejects an unknown top-level field (strict)", () => {
    expect(() => validateMetadata({ naame: "typo" })).toThrow(AfmValidationError);
  });

  it("rejects an unknown field inside a strict nested object", () => {
    expect(() => validateMetadata({ model: { provider: "openai", bogus: 1 } })).toThrow(
      AfmValidationError,
    );
  });

  it("rejects a wrong type", () => {
    expect(() => validateMetadata({ max_iterations: "five" })).toThrow(/max_iterations/);
  });

  it("applies the default string signature when omitted", () => {
    const md = validateMetadata({ interfaces: [{ type: "consolechat" }] });
    const iface = md.interfaces?.[0];
    expect(iface?.type === "consolechat" ? iface.signature.input : undefined).toEqual({ type: "string" });
    expect(iface?.type === "consolechat" ? iface.signature.output : undefined).toEqual({ type: "string" });
  });

  it("applies the default webchat exposure path /chat", () => {
    const md = validateMetadata({ interfaces: [{ type: "webchat" }] });
    const iface = md.interfaces?.[0];
    if (iface?.type === "webchat") {
      expect(iface.exposure.http?.path).toBe("/chat");
    }
  });

  describe("URL fields", () => {
    const withTransport = (url: string) => () =>
      validateMetadata({ tools: { mcp: [{ name: "s", transport: { type: "http", url } }] } });

    it("accepts http and https", () => {
      expect(withTransport("https://mcp.example.com/mcp")).not.toThrow();
      expect(withTransport("http://localhost:8787/")).not.toThrow();
    });

    it("rejects a scheme that is never a server to call", () => {
      expect(withTransport("javascript:alert(1)")).toThrow(/http:\/\/ or https:\/\//);
      expect(withTransport("file:///etc/passwd")).toThrow(/transport.url/);
      expect(withTransport("data:text/plain,x")).toThrow(/transport.url/);
    });

    it("leaves an unresolved variable alone", () => {
      expect(withTransport("${env:MCP_URL}")).not.toThrow();
      expect(withTransport("https://${env:REGION}.example.com/mcp")).not.toThrow();
    });

    it("applies the same rule to model.url, provider.url and icon_url", () => {
      expect(() => validateMetadata({ icon_url: "javascript:x" })).toThrow(/icon_url/);
      expect(() => validateMetadata({ model: { url: "file:///x" } })).toThrow(/model.url/);
      expect(() => validateMetadata({ provider: { url: "data:x" } })).toThrow(/provider.url/);
      expect(() => validateMetadata({ icon_url: "https://example.com/i.png" })).not.toThrow();
    });
  });
});

describe("validateMetadata: authentication", () => {
  const authOf = (authentication: Record<string, unknown>) => ({ model: { authentication } });
  const accepted = (authentication: Record<string, unknown>) => validateMetadata(authOf(authentication)).model?.authentication;

  it("accepts a complete bearer, basic and api-key block", () => {
    expect(accepted({ type: "bearer", token: "t" })?.type).toBe("bearer");
    expect(accepted({ type: "basic", username: "u", password: "p" })?.type).toBe("basic");
    expect(accepted({ type: "api-key", api_key: "k", header_name: "X-Key" })?.type).toBe("api-key");
  });

  it("reads the type without regard to case", () => {
    expect(accepted({ type: "BEARER", token: "t" })?.type).toBe("BEARER");
  });

  it("counts a value that is still a variable as present", () => {
    expect(() => validateMetadata(authOf({ type: "bearer", token: "${env:TOKEN}" }))).not.toThrow();
  });

  it.each([
    ["bearer without a token", { type: "bearer" }, /type 'bearer' requires 'token'/],
    ["bearer with an empty token", { type: "bearer", token: "" }, /requires 'token'/],
    ["basic without a password", { type: "basic", username: "u" }, /requires 'password'/],
    ["an api key without the key", { type: "api-key", header_name: "X" }, /requires 'api_key'/],
    ["a field bearer does not support", { type: "bearer", token: "t", api_key: "x" }, /does not support 'api_key'/],
    ["a typed field set to null", { type: "bearer", token: "t", header_name: null }, /received null/],
    ["another field set to null", { type: "jwt", issuer: "i", audience: "a", signing_key: "k", key_id: null }, /must not set 'key_id' field to null/],
    ["a type nobody defined", { type: "carrier-pigeon", address: "coop" }, /authentication type is not recognized/],
    ["an extension type", { type: "x-aws-sigv4", region: "us-east-1" }, /not recognized/],
    ["no type at all", {}, /./],
  ])("rejects %s", (_label, authentication, message) => {
    expect(() => validateMetadata(authOf(authentication))).toThrow(message);
  });

  it.each([["constructor"], ["__proto__"], ["toString"]])("rejects the type %s as not recognized, not with a crash", (type) => {
    const check = () => validateMetadata(authOf({ type }));
    expect(check).toThrow(AfmValidationError);
    expect(check).toThrow(/not recognized/);
  });

  describe("jwt", () => {
    const jwt = { type: "jwt", issuer: "i", audience: "a", signing_key: "${env:KEY}" };

    it("accepts the required fields and the optional ones", () => {
      expect(accepted(jwt)?.type).toBe("jwt");
      expect(accepted({ ...jwt, audience: ["a", "b"], algorithm: "HS256", key_id: "k", subject: "s", custom_claims: { team: "x" }, expiry_seconds: 60 })?.type).toBe("jwt");
    });

    it("requires issuer, audience and signing_key", () => {
      expect(() => validateMetadata(authOf({ type: "jwt" }))).toThrow(/requires 'issuer', 'audience', 'signing_key'/);
    });

    it("rejects a field jwt does not support", () => {
      expect(() => validateMetadata(authOf({ ...jwt, token: "t" }))).toThrow(/does not support 'token'/);
    });
  });

  describe("oauth2", () => {
    const credentials = { type: "oauth2", grant_type: "client_credentials", token_url: "https://auth.example.com/token", client_id: "i", client_secret: "s" };
    const jwtBearer = {
      type: "oauth2",
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      token_url: "https://auth.example.com/token",
      client_id: "i",
      client_secret: "s",
      assertion_signing: { issuer: "i", audience: "a", signing_key: "k" },
    };

    it("accepts the client credentials grant and the jwt-bearer grant", () => {
      expect(accepted(credentials)?.type).toBe("oauth2");
      expect(accepted({ ...credentials, scopes: ["read"], token_endpoint_auth_method: "client_secret_post", resource: "https://r", extra_params: { a: "b" } })?.type).toBe("oauth2");
      expect(accepted(jwtBearer)?.type).toBe("oauth2");
      expect(accepted({ ...jwtBearer, client_id: undefined, client_secret: undefined, token_endpoint_auth_method: "none" })?.type).toBe("oauth2");
    });

    it("requires a grant_type", () => {
      expect(() => validateMetadata(authOf({ type: "oauth2" }))).toThrow(/requires a 'grant_type'/);
    });

    it.each(["authorization_code", "password", "refresh_token", "implicit", "constructor", "__proto__"])("refuses the %s grant", (grant) => {
      const check = () => validateMetadata(authOf({ type: "oauth2", grant_type: grant }));
      expect(check).toThrow(AfmValidationError);
      expect(check).toThrow(/requires a 'grant_type' of client_credentials or/);
    });

    it("requires the token address and the client credentials", () => {
      expect(() => validateMetadata(authOf({ type: "oauth2", grant_type: "client_credentials" }))).toThrow(/requires 'token_url'/);
      expect(() => validateMetadata(authOf({ ...credentials, client_secret: undefined }))).toThrow(/requires 'client_id' and 'client_secret'/);
    });

    it("rejects a field the grant does not support", () => {
      expect(() => validateMetadata(authOf({ ...credentials, assertion_signing: { issuer: "i", audience: "a", signing_key: "k" } }))).toThrow(/does not support 'assertion_signing'/);
      expect(() => validateMetadata(authOf({ ...credentials, redirect_uri: "https://a" }))).toThrow(/does not support 'redirect_uri'/);
    });

    it("allows no client authentication only for the jwt-bearer grant", () => {
      expect(() => validateMetadata(authOf({ ...credentials, client_id: "i", client_secret: undefined, token_endpoint_auth_method: "none" }))).toThrow(/only for the jwt-bearer grant/);
      expect(() => validateMetadata(authOf({ ...jwtBearer, token_endpoint_auth_method: "none" }))).toThrow(/must not set 'client_secret'/);
    });

    it("requires a closed assertion_signing object for the jwt-bearer grant", () => {
      expect(() => validateMetadata(authOf({ ...jwtBearer, assertion_signing: undefined }))).toThrow(/requires 'assertion_signing'/);
      expect(() => validateMetadata(authOf({ ...jwtBearer, assertion_signing: "key" }))).toThrow(/must be an object/);
      expect(() => validateMetadata(authOf({ ...jwtBearer, assertion_signing: { issuer: "i", audience: "a" } }))).toThrow(/requires 'signing_key'/);
      expect(() => validateMetadata(authOf({ ...jwtBearer, assertion_signing: { issuer: "i", audience: "a", signing_key: "k", extra: 1 } }))).toThrow(/does not support 'extra'/);
    });
  });
});

describe("validateMetadata: interfaces", () => {
  describe("interfaces (discriminated union)", () => {
    it("rejects an unknown interface type", () => {
      expect(() => validateMetadata({ interfaces: [{ type: "carrierpigeon" }] })).toThrow(
        AfmValidationError,
      );
    });

    it("accepts a webhook interface", () => {
      const md = validateMetadata({
        interfaces: [
          { type: "webhook", subscription: { protocol: "websub" } },
        ],
      });
      expect(md.interfaces?.[0]?.type).toBe("webhook");
    });

    it("accepts webhook without subscription and with an empty HTTP exposure", () => {
      const md = validateMetadata({ interfaces: [{ type: "webhook", exposure: { http: {} }, signature: { output: { type: "object" } } }] });
      expect(md.interfaces?.[0]?.type).toBe("webhook");
    });

    it("accepts all three platformchat modes and their mode-specific fields", () => {
      const md = validateMetadata({ interfaces: [
        {
          type: "platformchat",
          platform: "slack",
          mode: "notification",
          prompt: "${http:payload.event}",
          platform_config: { signing_secret: "${env:SLACK_SECRET}" },
          signature: { input: { type: "object" } },
          exposure: { http: {} },
        },
        {
          type: "platformchat",
          platform: "gchat",
          mode: "request",
          signature: { output: { type: "object", properties: { text: { type: "string" } } } },
          exposure: { http: { path: "/gchat" } },
        },
        {
          type: "platformchat",
          platform: "telegram",
          mode: "polling",
          polling: { interval: 30, timeout: 25 },
          authentication: { type: "api-key", api_key: "${env:BOT_TOKEN}" },
        },
      ] });
      expect(md.interfaces?.map((iface) => iface.type)).toEqual(["platformchat", "platformchat", "platformchat"]);
    });

    it("accepts a variable-backed poll interval until it can be resolved", () => {
      const polling = (interval: unknown) => () =>
        validateMetadata({ interfaces: [{ type: "platformchat", platform: "telegram", mode: "polling", polling: { interval } }] });
      expect(polling("${env:POLL_SECONDS}")).not.toThrow();
      expect(polling(-1)).toThrow(AfmValidationError);
    });

    it("rejects fields forbidden by a platformchat mode", () => {
      const cases = [
        { mode: "notification", signature: { output: { type: "string" } } },
        { mode: "polling", signature: { output: { type: "string" } } },
        { mode: "polling", exposure: { http: {} } },
        { mode: "request", polling: { interval: 5 } },
      ];
      for (const fields of cases) {
        expect(() => validateMetadata({ interfaces: [{ type: "platformchat", platform: "slack", ...fields }] })).toThrow(AfmValidationError);
      }
      expect(() => validateMetadata({ interfaces: [{ type: "platformchat", platform: "slack", mode: "later" }] })).toThrow(AfmValidationError);
      expect(() => validateMetadata({ interfaces: [{ type: "platformchat", mode: "request" }] })).toThrow(AfmValidationError);
    });
  });

  describe("recursive JSON Schema in a signature", () => {
    it("validates nested object properties", () => {
      const md = validateMetadata({
        interfaces: [
          {
            type: "webchat",
            signature: {
              input: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
            },
          },
        ],
      });
      const iface = md.interfaces?.[0];
      expect(iface?.type === "webchat" ? iface.signature.input : undefined).toEqual({
        type: "object", properties: { x: { type: "string" } }, required: ["x"],
      });
    });

    it("accepts boolean and reference schemas", () => {
      const input = { $ref: "#/$defs/Message", $defs: { Message: { type: "string" } } };
      expect(() => validateMetadata({ interfaces: [{ type: "webchat", signature: { input, output: true } }] })).not.toThrow();
    });

    it("does not check a declared schema beyond its shape, since nothing here validates data against it", () => {
      for (const input of [{ type: "bogus" }, { $schema: "http://json-schema.org/draft-04/schema#", type: "string" }, { properties: [] }, {}]) {
        expect(() => validateMetadata({ interfaces: [{ type: "webchat", signature: { input } }] })).not.toThrow();
      }
    });

    it("still requires a schema to be an object or a boolean", () => {
      for (const input of ["string", 5, null, ["string"]]) {
        expect(() => validateMetadata({ interfaces: [{ type: "webchat", signature: { input } }] })).toThrow();
      }
    });

    it("reads a signature without compiling any code", () => {
      const original = globalThis.Function;
      globalThis.Function = function blocked() {
        throw new EvalError("Code generation from strings is blocked.");
      } as unknown as FunctionConstructor;
      try {
        expect(jsonSchema.safeParse({ type: "object", properties: { a: { type: "string" } } }).success).toBe(true);
        expect(jsonSchema.safeParse(true).success).toBe(true);
      } finally {
        globalThis.Function = original;
      }
    });

    it("validates declared JSON Schema dialects", () => {
      for (const dialect of [
        "http://json-schema.org/draft-07/schema#",
        "https://json-schema.org/draft/2019-09/schema",
        "https://json-schema.org/draft/2020-12/schema",
      ]) {
        expect(() => validateMetadata({ interfaces: [{ type: "webchat", signature: {
          input: { $schema: dialect, type: "object", properties: { value: { type: "string" } } },
        } }] })).not.toThrow();
      }
    });
  });
});

describe("validateMetadata: tools", () => {
  describe("transport (discriminated union)", () => {
    it("requires url for http transport", () => {
      expect(() =>
        validateMetadata({ tools: { mcp: [{ name: "s", transport: { type: "http" } }] } }),
      ).toThrow(AfmValidationError);
    });

    it("accepts stdio transport with a command", () => {
      const md = validateMetadata({
        tools: { mcp: [{ name: "s", transport: { type: "stdio", command: "node" } }] },
      });
      expect(md.tools?.mcp?.[0]?.transport.type).toBe("stdio");
    });

    it("rejects an unknown transport type", () => {
      expect(() =>
        validateMetadata({ tools: { mcp: [{ name: "s", transport: { type: "ftp" } }] } }),
      ).toThrow(AfmValidationError);
    });
  });

  describe("skills (discriminated union)", () => {
    it("accepts a local skill source", () => {
      const md = validateMetadata({ skills: [{ type: "local", path: "./skills" }] });
      expect(md.skills?.[0]).toEqual({ type: "local", path: "./skills" });
    });

    it("rejects a url skill source: the spec defines only the local one", () => {
      expect(() =>
        validateMetadata({ skills: [{ type: "url", url: "https://example.com/skills/pdf/SKILL.md" }] }),
      ).toThrow(/local/);
    });

    it("requires path for a local source", () => {
      expect(() => validateMetadata({ skills: [{ type: "local" }] })).toThrow(AfmValidationError);
    });

    it("requires url for a url source", () => {
      expect(() => validateMetadata({ skills: [{ type: "url" }] })).toThrow(AfmValidationError);
    });

    it("rejects an unknown skill source type", () => {
      expect(() => validateMetadata({ skills: [{ type: "s3", path: "x" }] })).toThrow(
        AfmValidationError,
      );
    });

    it("rejects unknown fields on a skill source", () => {
      expect(() =>
        validateMetadata({ skills: [{ type: "local", path: "./skills", extra: true }] }),
      ).toThrow(AfmValidationError);
    });
  });

  it("requires unique MCP connection names and valid HTTP URLs", () => {
    expect(() => validateMetadata({ tools: { mcp: [
      { name: "same", transport: { type: "http", url: "https://example.com/a" } },
      { name: "same", transport: { type: "stdio", command: "node" } },
    ] } })).toThrow(/Duplicate MCP server name/);
    expect(() => validateMetadata({ model: { url: "not-a-url" } })).toThrow(/model.url/);
    expect(() => validateMetadata({ tools: { mcp: [{ name: "x", transport: { type: "http", url: "example.com/mcp" } }] } })).toThrow(/transport.url/);
  });
});
