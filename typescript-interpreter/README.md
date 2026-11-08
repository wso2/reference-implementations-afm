# TypeScript Interpreter

An interpreter for [Agent-Flavored Markdown (AFM)](https://wso2.github.io/agent-flavored-markdown/) agents. It reads an `.afm.md` file and runs the agent as a console chat.

## Run it

You need Node.js 24 and pnpm 11 (the `packageManager` field pins the version), or Docker.

```sh
cd typescript-interpreter
pnpm install --frozen-lockfile
pnpm run build
export OPENAI_API_KEY=<YOUR-API-KEY>
node dist/main.js path/to/agent.afm.md
```

Type a message and press Enter. Type `exit` or `quit` to leave.

With Docker, mount the agent file, pass the variables it needs, and keep the input open with `-i`:

```sh
docker build -t afm-typescript-interpreter .
docker run --rm -i \
  -e OPENAI_API_KEY=<YOUR-API-KEY> \
  -v "$(pwd)/path/to/agent.afm.md:/agent/agent.afm.md" \
  afm-typescript-interpreter /agent/agent.afm.md
```

A small agent file:

```md
---
name: "Math Tutor"
model:
  provider: "openai"
  name: "gpt-4o"
  authentication:
    type: "api-key"
    api_key: "${env:OPENAI_API_KEY}"
tools:
  mcp:
    - name: "math"
      transport:
        type: "http"
        url: "${env:MATH_MCP_SERVER}"
---

# Role
You are a patient math tutor.

# Instructions
Explain each step. Use the math tools for calculations.
```

## What it supports

| AFM feature | Support |
|---|---|
| Console chat (the default interface) | yes |
| OpenAI and Anthropic models, with `model.url` as the base address of the provider's API | yes |
| A model key from the file, or from `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | yes |
| MCP tool servers over HTTP and over stdio, with `tool_filter` | yes |
| `bearer`, `basic` and `api-key` authentication | yes |
| Skills (`SKILL.md`, loaded on demand) | yes |
| `max_iterations` (default 10) | yes |
| `spec_version` other than 0.4.0 | a warning |
| Variables `${env:NAME}` in the whole file, `${http:...}` kept for webhooks | yes |
| Web chat, webhook and platform chat interfaces | not yet supported by this interpreter |
| `jwt` and `oauth2` authentication | not yet supported by this interpreter |

A file that uses something not yet supported stops with a message that says so. A tool server that cannot be reached is skipped with a warning, and the interpreter stops if none can be reached. When a reply stops early (the `max_iterations` limit, the model's length limit or its content filter), the console says why.

## Variables and security

- `${env:NAME}` and `${NAME}` are replaced with the value of the environment variable. A missing or empty variable stops the interpreter and names the variable, never a value.
- Values are replaced after the file is read, so a value cannot change the structure of the file. They are also replaced in Role and Instructions, so the model sees them. Run only agent files you trust.
- `${http:...}` is allowed only in the `prompt` of a webhook or platform chat interface.
- Credentials are never sent to a plain `http://` address (`localhost` is allowed), and a tool server that answers with a redirect is refused.
- A stdio tool server gets only the `env` of the agent file plus a few basic variables such as `PATH`.
- Skill files are read only from the skill's own `references/` and `assets/` folders.

## Packages

| Package | Purpose |
|---|---|
| `@afm/engine` | Reads an agent file: parsing, validation, variables. Works anywhere JavaScript runs. |
| `@afm/runtime` | Runs the agent: the model, tool servers and the agent loop. Its `main.ts`, `agent.ts`, `console-chat.ts`, `stdio.ts` and `skills.ts` use Node.js and are not part of its public entry. |

The packages are private workspace packages and are not published to npm. Their entry points export TypeScript source.

To use them as libraries:

```ts
import { loadAfm } from "@afm/engine";
import { createModel, mcpTools, runAgentTurn } from "@afm/runtime";

const loaded = loadAfm(text, { env: process.env });
const model = createModel(loaded.metadata.model, { env: process.env });
const turn = runAgentTurn({ system: loaded.systemPrompt, messages, model, tools: {}, maxIterations: loaded.metadata.max_iterations });
for await (const event of turn) { /* text-delta, tool-call, tool-result, usage, turn-complete, finish */ }
```

`createModel` and `mcpTools` take an optional `fetch`, so a program that uses them can supply its own, for example to add headers or log requests.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run check      # typecheck and tests
pnpm run build      # dist/main.js
```

The tests include an end-to-end run of the built `main.js` against fake model and tool servers, and a check that the library files import no Node.js module. The tests also load six example agents from the AFM specification (`packages/engine/fixtures/agents/`).

## License

Apache License 2.0. See the repository [LICENSE](../LICENSE).
