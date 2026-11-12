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
import { describe, it, expect } from "vitest";
import type { AgentMetadata } from "@afm/engine";
import {
  plannedRows,
  resultOf,
  answeredBy,
  credentialOf,
  issueSentence,
  everyRowReady,
  attentionCount,
  checkingResult,
  changedResult,
  summaryOf,
  reachOf,
  displayName,
  valuesRow,
  looksLikeSecret,
  type SetupRow,
} from "./setup-check";

const metadata = {
  model: { provider: "openai", name: "gpt-4o", authentication: { type: "api-key", api_key: "${env:OPENAI_API_KEY}" } },
  tools: {
    mcp: [
      { name: "arxiv", transport: { type: "http", url: "https://arxiv.example/mcp" } },
      {
        name: "huggingface",
        transport: {
          type: "http",
          url: "https://hf.example/mcp",
          authentication: { type: "bearer", token: "${env:HF_TOKEN}" },
        },
        tool_filter: { allow: ["a", "b"] },
      },
      {
        name: "notion",
        transport: {
          type: "http",
          url: "https://notion.example/mcp",
          authentication: {
            type: "oauth2",
            grant_type: "authorization_code",
            authorize_url: "https://n/a",
            token_url: "https://n/t",
            client_id: "c",
          },
        },
      },
      { name: "local", transport: { type: "stdio", command: "run" } },
    ],
  },
} as unknown as AgentMetadata;

const [arxiv, huggingface, notion] = metadata.tools!.mcp!;

describe("plannedRows with a model name of only spaces", () => {
  it("asks for a model, like an empty name", () => {
    const [row] = plannedRows({ name: "A", model: { provider: "openai", name: "  " } } as AgentMetadata);
    expect(row).toMatchObject({ name: "Choose a model", state: "needs" });
  });
});

describe("plannedRows", () => {
  it("has one row for the model and one for each server a browser can reach", () => {
    expect(plannedRows(metadata).map((row) => row.id)).toEqual([
      "model",
      "server:arxiv",
      "server:huggingface",
      "server:notion",
    ]);
  });

  it("starts every row waiting, saying what it will be asked with", () => {
    expect(plannedRows(metadata).map((row) => [row.state, row.note])).toEqual([
      ["waiting", "OpenAI"],
      ["waiting", "No key needed"],
      ["waiting", "Access token"],
      ["waiting", "Sign-in"],
    ]);
  });

  it("asks for a model first when the file names none", () => {
    const [model] = plannedRows({ ...metadata, model: { provider: "openai" } });
    expect(model).toMatchObject({ state: "needs", note: "No model yet" });
  });
});

describe("credentialOf", () => {
  it("tells no credential from a token and a sign-in", () => {
    expect([arxiv, huggingface, notion].map((server) => credentialOf(server!))).toEqual(["none", "token", "signin"]);
  });
});

describe("resultOf", () => {
  const context = { credential: "token" as const, hadSignIn: false, answered: "2 allowed" };

  it("is ready once the server answered", () => {
    expect(resultOf({ tools: [] }, context)).toEqual({ state: "ready", note: "2 allowed · connected" });
  });

  it("says the key was accepted for the model", () => {
    expect(resultOf({}, { credential: "key", hadSignIn: false, answered: "OpenAI" })).toEqual({
      state: "ready",
      note: "OpenAI · authenticated",
    });
  });

  it("needs setup, not a failure, when nothing was provided", () => {
    expect(resultOf({ failure: { kind: "missing", message: "" } }, context)).toEqual({
      state: "needs",
      note: "No token yet",
      failure: "missing",
    });
  });

  it("calls a missing sign-in never made, and a sign-in that was held ended", () => {
    const failure = { kind: "signin" as const, message: "" };
    expect(resultOf({ failure }, { credential: "signin", hadSignIn: false, answered: "" })).toMatchObject({
      state: "needs",
      note: "Not signed in",
      failure: "missing",
    });
    expect(resultOf({ failure }, { credential: "signin", hadSignIn: true, answered: "" })).toMatchObject({
      state: "failed",
      note: "Sign-in ended",
    });
  });

  it("words a refusal by what was refused", () => {
    const failure = { kind: "rejected" as const, message: "" };
    expect(resultOf({ failure }, context).note).toBe("Token not accepted");
    expect(resultOf({ failure }, { ...context, credential: "key" }).note).toBe("Key not accepted");
    expect(resultOf({ failure }, { ...context, credential: "signin" }).note).toBe("Sign-in ended");
  });

  it("words a server that is slow, busy or out of reach without blaming the credential", () => {
    const note = (kind: "slow" | "busy" | "unreachable") => resultOf({ failure: { kind, message: "" } }, context).note;
    expect([note("slow"), note("busy"), note("unreachable")]).toEqual([
      "Did not answer in time",
      "Busy right now",
      "Can't be reached",
    ]);
  });

  it("says a server that redirects is not a server that is down", () => {
    expect(resultOf({ failure: { kind: "redirected", message: "" } }, context)).toMatchObject({
      state: "failed",
      note: "Redirects elsewhere",
      failure: "redirected",
    });
  });

  it("says MCP error for anything it cannot place, and keeps the long text off the screen", () => {
    expect(resultOf({ failure: { kind: "other", message: "Odd reply" } }, context)).toMatchObject({
      state: "failed",
      note: "MCP error",
    });
  });

  it("says Model error when it is the model that failed", () => {
    expect(
      resultOf({ failure: { kind: "other", message: "Odd reply" } }, { ...context, credential: "key" }),
    ).toMatchObject({ state: "failed", note: "Model error" });
  });
});

describe("answeredBy", () => {
  it("counts the tools the file allows, or the ones the server reported when it lists none", () => {
    expect(answeredBy(huggingface!, 40)).toBe("2 allowed");
    expect(answeredBy(arxiv!, 4)).toBe("4 tools");
    expect(answeredBy(arxiv!, 1)).toBe("1 tool");
  });
});

describe("issueSentence", () => {
  it("names who failed and what to do", () => {
    expect(issueSentence("slow", "Notion", "signin")).toBe("Notion did not answer in time. Try again in a moment.");
    expect(issueSentence("rejected", "Hugging Face", "token")).toBe(
      "Hugging Face did not accept this token. Paste a new one.",
    );
    expect(issueSentence("rejected", "Notion", "signin")).toBe("Notion's sign-in has ended. Sign in to carry on.");
    expect(issueSentence("rejected", "api.openai.com", "key")).toBe(
      "api.openai.com did not accept this key. Paste a new one.",
    );
    expect(issueSentence("missing", "Notion", "signin")).toBe("Notion needs you to sign in.");
    expect(issueSentence("redirected", "Notion", "token")).toBe(
      "Notion answered with a redirect, which AFM does not follow. Use the address it redirects to.",
    );
    expect(issueSentence("other", "Notion", "signin", "Odd reply")).toBe("MCP error");
  });
});

describe("the whole list", () => {
  const rows = (...states: SetupRow["state"][]): SetupRow[] =>
    states.map((state, index) => ({ id: String(index), kind: "server", name: "s", state, note: "" }));

  it("can run only when every row is ready, and never when there are none", () => {
    expect(everyRowReady(rows("ready", "ready"))).toBe(true);
    expect(everyRowReady(rows("ready", "changed"))).toBe(false);
    expect(everyRowReady([])).toBe(false);
  });

  it("counts the rows that need the user, not the ones still working or changed", () => {
    expect(attentionCount(rows("needs", "failed", "checking", "changed", "ready"))).toBe(2);
  });

  it("describes a row being checked and one that was changed", () => {
    expect(checkingResult("signin")).toEqual({ state: "checking", note: "Connecting with your sign-in" });
    expect(changedResult.state).toBe("changed");
  });
});

describe("looksLikeSecret", () => {
  it("flags names that ask for a key, token, password or secret, and not plain settings", () => {
    for (const name of ["API_KEY", "slack_token", "DB_PASSWORD", "CLIENT_SECRET", "BEARER_VALUE", "openai_key"]) {
      expect(looksLikeSecret(name)).toBe(true);
    }
    for (const name of ["REGION", "TEAM_NAME", "MCP_URL", "LANGUAGE"]) expect(looksLikeSecret(name)).toBe(false);
  });
});

describe("valuesRow", () => {
  it("has no row when the file asks for no values", () => {
    expect(valuesRow([], {})).toEqual([]);
  });

  it("needs the values that are empty or only spaces, and names them", () => {
    const [row] = valuesRow(["REGION", "TEAM", "SITE"], { REGION: "eu", TEAM: "   " });
    expect(row).toMatchObject({ id: "values", kind: "values", name: "Values", state: "needs" });
    expect(row!.note).toBe("Needs TEAM, SITE");
  });

  it("needs a value named like an object property until it is really entered", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(valuesRow([name], {})[0]).toMatchObject({ state: "needs", note: `Needs ${name}` });
      expect(valuesRow([name], Object.fromEntries([[name, "x"]]))[0]).toMatchObject({ state: "ready" });
    }
  });

  it("is ready once every value is entered, so the agent can run", () => {
    const rows = valuesRow(["REGION", "TEAM"], { REGION: "eu", TEAM: "core" });
    expect(rows[0]).toMatchObject({ state: "ready", note: "2 values entered" });
    expect(everyRowReady(rows)).toBe(true);
  });

  it("keeps the whole list from being ready while a value is missing", () => {
    const rows = [...plannedRows(metadata), ...valuesRow(["REGION"], {})].map((row) => ({ ...row, state: row.kind === "values" ? row.state : ("ready" as const) }));
    expect(everyRowReady(rows)).toBe(false);
    expect(attentionCount(rows)).toBe(1);
  });
});

describe("summaryOf", () => {
  const row = (state: SetupRow["state"], name = "notion"): SetupRow => ({
    id: name,
    kind: "server",
    name,
    state,
    note: "",
  });

  it("reads Checking while any row is still asked", () => {
    expect(summaryOf([row("ready"), row("checking", "linear")]).chip).toBe("Checking");
  });

  it("counts the rows that need the user, and says the rest is ready", () => {
    expect(summaryOf([row("ready"), row("failed", "linear"), row("needs", "hf")])).toEqual({
      tone: "warn",
      chip: "2 need attention",
      text: "The rest is ready. Fix these, then check again.",
    });
    expect(summaryOf([row("failed")]).chip).toBe("1 needs attention");
  });

  it("names what was changed", () => {
    expect(summaryOf([row("ready", "arxiv"), row("changed")])).toEqual({
      tone: "neutral",
      chip: "Changed",
      text: "You updated notion. Check again to confirm it.",
    });
  });

  it("reads Ready only when every row answered", () => {
    expect(summaryOf([row("ready"), row("ready", "linear")]).chip).toBe("Ready");
    expect(summaryOf([row("ready"), row("waiting", "linear")]).chip).toBe("Waiting");
  });

  it("only says to press Run once everything is ready", () => {
    expect(summaryOf([row("ready"), row("ready", "linear")]).text).toBe("Press Run to start.");
  });
});

describe("reachOf", () => {
  it("lists the servers that answered, and why the others did not", () => {
    const rows: SetupRow[] = [
      { id: "model", kind: "model", name: "GPT-4o", state: "ready", note: "" },
      { id: "server:a", kind: "server", name: "a", url: "https://a/mcp", state: "ready", note: "" },
      {
        id: "server:b",
        kind: "server",
        name: "b",
        url: "https://b/mcp",
        state: "failed",
        note: "Did not answer in time",
      },
      { id: "server:c", kind: "server", name: "c", url: "https://c/mcp", state: "needs", note: "No token yet" },
    ];
    expect(reachOf(rows)).toEqual({ ok: ["https://a/mcp"], failed: { "https://b/mcp": "Did not answer in time" } });
  });

  it("adds the servers that have answered a call, once each", () => {
    const rows: SetupRow[] = [
      { id: "server:a", kind: "server", name: "a", url: "https://a/mcp", state: "ready", note: "" },
    ];
    expect(reachOf(rows, ["https://a/mcp", "https://d/mcp"]).ok).toEqual(["https://a/mcp", "https://d/mcp"]);
  });
});

describe("displayName", () => {
  it("capitalises the first letter only", () => {
    expect(displayName("notion")).toBe("Notion");
    expect(displayName("hugging-face")).toBe("Hugging-face");
  });
});

describe("what a ready server row says", () => {
  it("says connected, not the unclear answered", () => {
    const row = resultOf({ tools: [] }, { credential: "none", hadSignIn: false, answered: "3 allowed" });
    expect(row.note).toBe("3 allowed · connected");
    expect(row.note).not.toContain("answered");
  });
});
