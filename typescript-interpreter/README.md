# TypeScript Interpreter

An interpreter for [Agent-Flavored Markdown (AFM)](https://wso2.github.io/agent-flavored-markdown/) agents. It reads an `.afm.md` file and runs the agent as a console chat, a web chat or a webhook, like the [Python](../python-interpreter) and [Ballerina](../ballerina-interpreter) interpreters.

## Run it

You need Node.js 24 and pnpm 11 (the `packageManager` field pins the version), or Docker.

```sh
cd typescript-interpreter
pnpm install --frozen-lockfile
pnpm run build
export OPENAI_API_KEY=<YOUR-API-KEY>
node dist/main.js path/to/agent.afm.md
```

Type a message and press Enter. Type `exit` or `quit` to leave. For a web chat or a webhook, see [Web chat and webhook](#web-chat-and-webhook).

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
| Web chat: an HTTP endpoint and a chat page | yes |
| Webhook: an HTTP endpoint, WebSub subscription, signed events and a prompt template | yes |
| OpenAI (Chat Completions API) and Anthropic models, with `model.url` as the base address of the provider's API | yes |
| A model key from the file, or from `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | yes |
| MCP tool servers over HTTP and over stdio, with `tool_filter` | yes |
| `bearer`, `basic` and `api-key` authentication | yes |
| Skills (`SKILL.md`, loaded on demand) | yes |
| `max_iterations` (default 10) | yes |
| `spec_version` 0.3.0 and 0.4.0 | yes. A missing or any other version gives a warning |
| Variables `${env:NAME}` in the whole file, `${http:payload...}` and `${http:header...}` in a webhook prompt | yes |
| Platform chat interface | not yet supported by this interpreter |
| Structured (JSON) input and output (`signature`) in console chat and web chat | yes. A webhook takes any JSON and ignores its signature |
| `jwt` and `oauth2` authentication | not yet supported by this interpreter |

A file that uses something not yet supported stops with a message that says so. A tool server that cannot be reached is skipped with a warning, and the interpreter stops if none can be reached. When a reply stops early (the `max_iterations` limit, the model's length limit or its content filter), the console says why.

## Web chat and webhook

An agent file chooses its interfaces with `interfaces`. With none, the agent is a console chat. With `webchat` or `webhook`, the interpreter starts an HTTP server (it does not read the console unless the file also lists `consolechat`) and runs until it gets SIGINT or SIGTERM.

```sh
node dist/main.js agent.afm.md                          # port 8085, all addresses
node dist/main.js agent.afm.md --port 9000 --host 127.0.0.1
docker run --rm -p 8085:8085 -e OPENAI_API_KEY=<YOUR-API-KEY> \
  -v "$(pwd)/agent.afm.md:/agent/agent.afm.md" afm-typescript-interpreter /agent/agent.afm.md
```

```yaml
interfaces:
  - type: webchat
    exposure:
      http:
        path: /chat          # the default
  - type: webhook
    prompt: "A ${http:payload.event} event came from ${http:header.User-Agent}."
    exposure:
      http:
        path: /webhook       # the default
    subscription:
      protocol: websub
      hub: "https://hub.example.com"
      topic: "https://example.com/events"
      callback: "https://agent.example.com/webhook"
      secret: ${env:WEBHOOK_SECRET}
```

| Request | What it does |
|---|---|
| `POST /chat` | Sends one message (`text/plain`, or a JSON string) and answers with the reply as text. The header `X-Session-Id` chooses the conversation; without it all requests share one, and so do the webhook events. A conversation is kept in memory for as long as the interpreter runs. |
| `GET /chat/ui` | A chat page for the web chat. It is served only when the input and the output are text, because the page sends plain text. |
| `GET /webhook` | Answers a WebSub hub's check of a subscription. |
| `POST /webhook` | Takes an event (JSON), answers `202`, then runs the agent with the prompt. With `subscription.secret`, the event must carry a matching `X-Hub-Signature-256` (or `X-Hub-Signature`) HMAC, or it gets `401`. Events are answered one at a time, in the shared conversation. |
| `GET /` and `GET /health` | The agent's name, description, version and interfaces, and `{"status":"ok"}`. Without them in the file, the name is the file name, the description is the first paragraph of the Role, and the version is `0.0.0`. |

Errors are JSON, like `{"detail": "..."}`. With `subscription.hub` and `subscription.topic`, the interpreter subscribes at the hub when it starts (three tries) and unsubscribes when it stops. It subscribes again when 80% of the lease the hub granted has passed. With `subscription.authentication`, it sends those credentials to the hub (not over plain `http://`, except on `localhost`). The callback is `subscription.callback`, or else an address made from the host and port.

The web chat has no sign-in: anyone who can reach the port can talk to the agent and use its tools. A web page that you open in the same browser can also send it messages (a plain `POST` needs no permission from the browser, and the reply stays unreadable, but the agent still acts), so do not run an agent with powerful tools on an open port. Put it behind a gateway that signs users in, or bind it to `127.0.0.1`. The webhook should always have a `subscription.secret`; without one the interpreter warns, and anyone can send events. A webhook takes at most ten events waiting or running, and answers `503` for more. A web chat keeps at most 1,000 conversations, and a request body may be at most 1 MB (25 MB for a webhook, the largest payload GitHub sends).

## Structured input and output

By default an agent takes text and answers with text. An interface can instead name JSON Schemas in `signature`:

```yaml
interfaces:
  - type: webchat
    signature:
      input:
        type: object
        properties: { city: { type: string } }
        required: [city]
      output:
        type: object
        properties: { summary: { type: string }, degrees: { type: number } }
        required: [summary]
```

- The input is checked against the schema. A value that is not text is given to the model as JSON.
- When the output is not text, the model is asked, after your message, to answer only with JSON that fits the schema inside a code block. The interpreter reads the JSON from the code block (a `json` block, any other block, or the bare reply), checks it against the schema, and returns it.
- The conversation keeps your original input, not the text about the schema.
- **Web chat:** the body must be `application/json` (a JSON string when the input is text). Input that does not fit gets `400` with the reason. An answer that does not fit the output schema gets `500` (the details go to the log, not to the caller). The reply is the JSON itself, or `{"response": ...}` when the output is text or is not an object.
- **Console chat:** each line you type must be JSON when the input is structured, and a structured answer is printed as indented JSON. A problem is printed as `[ERROR] ...` and the chat goes on.
- A schema the interpreter cannot use stops it at start, and says which side of which interface.

## Variables and security

- `${env:NAME}` and `${NAME}` are replaced with the value of the environment variable. A missing or empty variable stops the interpreter and names the variable, never a value.
- Values are replaced after the file is read, so a value cannot change the structure of the file. They are also replaced in Role and Instructions, so the model sees them. Run only agent files you trust.
- `${http:...}` is allowed only in the `prompt` of a webhook or platform chat interface. It is filled in for each event, from the payload and the headers; a field that is not there answers `400`.
- Credentials are never sent to a plain `http://` address (`localhost` is allowed), and a tool server that answers with a redirect is refused.
- A stdio tool server gets only the `env` of the agent file plus a few basic variables such as `PATH`.
- Skill files are read only from the skill's own `references/` and `assets/` folders.

## Packages

| Package | Purpose |
|---|---|
| `@afm/engine` | Reads an agent file: parsing, validation, variables. Works anywhere JavaScript runs. |
| `@afm/runtime` | Runs the agent: the model, tool servers and the agent loop. Its `main.ts`, `agent.ts`, `console-chat.ts`, `serve.ts`, `webchat.ts`, `webhook.ts`, `stdio.ts` and `skills.ts` use Node.js and are not part of its public entry. |

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
