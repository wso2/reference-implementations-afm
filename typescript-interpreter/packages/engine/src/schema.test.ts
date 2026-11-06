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
  describe("authentication required fields", () => {
    it("rejects bearer without a token", () => {
      expect(() =>
        validateMetadata({ model: { authentication: { type: "bearer" } } }),
      ).toThrow(/bearer/);
    });

    it("accepts an implementation-specific authentication type", () => {
      const md = validateMetadata({ model: { authentication: { type: "carrier-pigeon", address: "coop" } } });
      expect(md.model?.authentication?.type).toBe("carrier-pigeon");
    });

    it("accepts an x-* extension type with arbitrary fields, unvalidated", () => {
      const md = validateMetadata({
        model: { authentication: { type: "x-aws-sigv4", region: "us-east-1", service: "bedrock" } },
      });
      expect(md.model?.authentication?.type).toBe("x-aws-sigv4");
    });

    it("rejects a field bearer doesn't support", () => {
      expect(() =>
        validateMetadata({ model: { authentication: { type: "bearer", token: "t", api_key: "x" } } }),
      ).toThrow(/does not support/);
    });

    describe("jwt", () => {
      it("requires issuer and signing_key", () => {
        expect(() => validateMetadata({ model: { authentication: { type: "jwt" } } })).toThrow(
          /requires 'issuer', 'signing_key'/,
        );
      });

      it("accepts a minimal valid jwt block (audience/algorithm optional)", () => {
        const md = validateMetadata({
          model: { authentication: { type: "jwt", issuer: "afm-agent", signing_key: "${env:JWT_PRIVATE_KEY}" } },
        });
        expect(md.model?.authentication?.type).toBe("jwt");
      });

      it("rejects algorithm 'none'", () => {
        expect(() =>
          validateMetadata({
            model: { authentication: { type: "jwt", issuer: "i", signing_key: "k", algorithm: "none" } },
          }),
        ).toThrow(/'algorithm' 'none' is not allowed/);
      });

      it("rejects an unsupported algorithm", () => {
        expect(() =>
          validateMetadata({
            model: { authentication: { type: "jwt", issuer: "i", signing_key: "k", algorithm: "ES256" } },
          }),
        ).toThrow(/jwt 'algorithm' is not supported/);
      });
    });

    describe("oauth2", () => {
      it("requires grant_type", () => {
        expect(() => validateMetadata({ model: { authentication: { type: "oauth2" } } })).toThrow(
          /requires 'grant_type'/,
        );
      });

      it("rejects an unsupported grant_type", () => {
        expect(() =>
          validateMetadata({ model: { authentication: { type: "oauth2", grant_type: "implicit" } } }),
        ).toThrow(/oauth2 'grant_type' is not supported/);
      });

      it("requires the authorization_code fields", () => {
        expect(() =>
          validateMetadata({ model: { authentication: { type: "oauth2", grant_type: "authorization_code" } } }),
        ).toThrow(/requires 'authorize_url', 'token_url', 'client_id'/);
      });

      it.each(["client_credentials", "password", "refresh_token", "jwt_bearer"])("refuses the %s grant", (grant) => {
        expect(() => validateMetadata({ model: { authentication: { type: "oauth2", grant_type: grant } } })).toThrow(
          /oauth2 'grant_type' is not supported. Supported grant types: authorization_code/,
        );
      });

      it("rejects a field the grant doesn't support", () => {
        const authentication = {
          type: "oauth2",
          grant_type: "authorization_code",
          authorize_url: "https://auth.example.com/authorize",
          token_url: "https://auth.example.com/token",
          client_id: "i",
          client_secret: "s",
        };
        expect(() => validateMetadata({ model: { authentication } })).toThrow(/does not support 'client_secret'/);
      });

      it.each([["constructor"], ["__proto__"], ["toString"], ["hasOwnProperty"]])("rejects the grant_type %s as unsupported, not with a crash", (grant) => {
        const check = () => validateMetadata({ model: { authentication: { type: "oauth2", grant_type: grant } } });
        expect(check).toThrow(AfmValidationError);
        expect(check).toThrow(/grant_type' is not supported/);
      });

      it.each([
        ["token_url", "not-a-url"],
        ["token_url", "ftp://auth.example.com/token"],
        ["authorize_url", "/relative/authorize"],
      ])("rejects a %s that is not an http or https address: %s", (field, value) => {
        const authentication = {
          type: "oauth2",
          grant_type: "authorization_code",
          authorize_url: "https://auth.example.com/authorize",
          token_url: "https://auth.example.com/token",
          client_id: "c",
          [field]: value,
        };
        expect(() => validateMetadata({ model: { authentication } })).toThrow(new RegExp(`authentication.${field} must be`));
      });

      it("accepts a sign-in address that is still a variable", () => {
        const authentication = { type: "oauth2", grant_type: "authorization_code", authorize_url: "${env:AUTHORIZE_URL}", token_url: "${env:TOKEN_URL}", client_id: "i" };
        expect(() => validateMetadata({ model: { authentication } })).not.toThrow();
      });

      it("accepts the browser-runtime authorization_code grant without a client_secret", () => {
        const md = validateMetadata({
          model: {
            authentication: {
              type: "oauth2",
              grant_type: "authorization_code",
              authorize_url: "https://auth.example.com/authorize",
              token_url: "https://auth.example.com/token",
              client_id: "${env:OAUTH_CLIENT_ID}",
            },
          },
        });
        expect(md.model?.authentication?.type).toBe("oauth2");
      });

      it("authorization_code requires authorize_url", () => {
        expect(() =>
          validateMetadata({
            model: {
              authentication: {
                type: "oauth2",
                grant_type: "authorization_code",
                token_url: "https://auth.example.com/token",
                client_id: "id",
              },
            },
          }),
        ).toThrow(/requires 'authorize_url'/);
      });
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

    it("accepts a webhook interface (valid file even if the browser can't run it)", () => {
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

    it("does not check a declared schema beyond its shape, since the browser never validates data against it", () => {
      for (const input of [{ type: "bogus" }, { $schema: "http://json-schema.org/draft-04/schema#", type: "string" }, { properties: [] }, {}]) {
        expect(() => validateMetadata({ interfaces: [{ type: "webchat", signature: { input } }] })).not.toThrow();
      }
    });

    it("still requires a schema to be an object or a boolean", () => {
      for (const input of ["string", 5, null, ["string"]]) {
        expect(() => validateMetadata({ interfaces: [{ type: "webchat", signature: { input } }] })).toThrow();
      }
    });

    it("reads a signature without compiling any code, as a page that blocks eval requires", () => {
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
        tools: { mcp: [{ name: "s", transport: { type: "stdio", command: "python" } }] },
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
