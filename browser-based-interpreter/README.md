# AFM Browser-based Interpreter

A web app that runs an [Agent-Flavored Markdown (AFM)](https://wso2.github.io/agent-flavored-markdown/) agent in the browser. Write or paste an agent file, set up its model key and tools, then chat with it. The agent runs in a web worker inside the page, on the [TypeScript interpreter](../typescript-interpreter), the way the [Python](../python-interpreter) and [Ballerina](../ballerina-interpreter) interpreters run it on a server. There is no server to deploy, except the MCP proxy that tool servers over HTTP need.

## Features

- **Editor.** Edit an agent file in the Build view or switch to the Raw view, and see what is wrong before running.
- **One setup step.** Check everything the agent needs at once: the model key, each MCP tool server and its sign-in, and the plain values the file asks for.
- **Web chat.** Chat with the running agent, attach images, and approve or deny each tool call.
- **Tool servers over HTTP** with `bearer`, `basic`, `api-key` and OAuth sign-in (authorization code with PKCE), with `tool_filter`.
- **Share.** Share an agent as a link, or open one from a link or from the address of a raw file.
- **Safe by default.** Keys stay in the worker, in memory, and a key is released only to the address and provider it was entered for.

## Prerequisites

- [Node.js](https://nodejs.org/) 24.
- [pnpm](https://pnpm.io/) 11 (the `packageManager` field pins the version).
- A checkout of the whole repository. The two `@afm/*` packages (`engine` and `runtime`) are installed from the `typescript-interpreter/` folder next to this one (`file:../typescript-interpreter/packages/*`).
- An MCP proxy, if the agents you run use tool servers over HTTP. A page cannot call such a server directly, so the app refuses to connect one without a proxy.

## Quick Start

```sh
cd browser-based-interpreter
pnpm install --frozen-lockfile
pnpm dev        # http://localhost:5173
```

Open the address, start a blank agent or one of the examples, press Run, enter the model key in Setup and chat.

## Configuration

Settings are read when the app is built. For development, copy `.env.example` to `.env.local` and set what you need.

| Variable | Required | What it does |
|---|---|---|
| `VITE_MCP_PROXY_URL` | For tool servers over HTTP | The address of a running MCP proxy. Every request to a tool server, its sign-in discovery and a `?file=` link goes through it. |
| `VITE_MCP_PROXY_SESSION_HEADER` | No | The request header that carries the session id the proxy issues. Default `X-Choreo-Correlation-Id`. The proxy must allow the header in CORS and expose it in its responses. |
| `VITE_OAUTH_CLIENT_ID_URL` | No | The public address of the app's own OAuth Client ID Metadata Document. A production build writes the document to `oauth/client-metadata.json`, so set it to the address the site is served from. Without it, the app registers itself with each server that supports Dynamic Client Registration. |

## What it supports

| AFM feature | Support in the browser |
|---|---|
| Web chat interface | yes |
| OpenAI and Anthropic models | yes |
| MCP tool servers over HTTP, with `tool_filter` | yes, through the proxy |
| `bearer`, `basic` and `api-key` authentication | yes |
| `oauth2` authorization code (sign-in) | yes |
| `max_iterations` | yes |
| Variables `${env:NAME}` | yes, see [Keys and values](#keys-and-values) |
| Console chat, webhook and platform chat interfaces | no, the app says so before it runs the agent |
| MCP tool servers over stdio, and skills | no, a browser cannot run them |
| `model.url` (a custom model address) | no, the run is blocked, so a key cannot be sent to another address |
| `jwt` and OAuth client-credentials authentication | no |

## Keys and values

- **Keys.** `${env:NAME}` inside an `authentication` block is a key. Type it in the key box, never into the agent file: the file keeps only the reference. The key lives in the worker, in memory, and is gone when the tab closes. A tool server's key is sent only to the server address it was entered for. A model key is sent only to the provider it was entered for, and a key entered for one provider is never used for the other.
- **Values.** `${env:NAME}` anywhere else in the front matter (a server address, a description, a setting) is a plain value, not a key. Setup shows a Values row where you type it. It is kept in the page for the tab, is never used as a key, and cannot take a key you entered.
- **Role and Instructions.** Variables there are left as written.

## How it uses the interpreter

The interpreter (`@afm/engine` and `@afm/runtime`) does the work every AFM runtime shares: it reads and checks the file, fills in variables, creates the model, connects to tool servers and runs the agent loop. The app adds what only a page needs, in `src/core`:

- **Sign-in and the proxy.** OAuth sign-in blocks are not part of the AFM specification, so the app takes them out of the file before the interpreter checks it. Requests to tool servers go through the proxy, with the sign-in token added; requests to Anthropic carry the header it asks of browsers. The interpreter takes each of these as a `fetch` function for its connection.
- **Permissions.** Every tool call goes through the app's guard, which asks first unless you allowed the tool. A tool named in `tool_filter.allow` is only offered to the agent; it still asks.
- **What a browser cannot run.** Stdio tool servers, skills, a custom model address, other interfaces than web chat and jwt or client-credentials sign-in are left out, and the app says so before it runs the agent.
- **Key check.** The check makes one tiny real request to the model, so it also proves the chosen model is available to the key.

## Using AFM Safely

- **Keys.** Do not put keys in a server address: addresses pass through the MCP proxy and its gateway logs. Every MCP credential and OAuth token passes through the proxy on its way to the tool server (the proxy passes the `Authorization` and key headers on), so use only a proxy you trust. The share panel warns if a key is written into the file.
- **Shared agents.** An agent opened from a link or a file shows a screen first: its model, each tool server and its host, and the keys it needs. Its Permissions button lets you select, by name, which of the tools the file lists may run without asking; every other tool asks first, in the chat. Open it in the builder to read it before it runs, and run only agents from people you trust, because the author decides what the agent is told to do.
- **Signing in.** Pressing Sign in on a tool server first asks you to confirm, and names the site where the sign-in window opens. Type your password only in that window.
- **Tool approvals.** When a tool needs permission, a small card appears in the chat under the tool call. It shows the tool, the host it goes to and the full arguments, with three choices: Allow, Always allow and Deny. Nothing runs until you decide. "Always allow" selects the tool in Permissions, so it is visible, can be undone there, and is saved with the agent. Stop denies a waiting question.
- **Pictures.** A picture you attach is redrawn before it is sent, so the camera, date and location details the file carries stay on your device. Only the pixels go to the model.
- **Prompt injection.** Pages, documents and tool results the agent reads can contain instructions that try to steer it. No model can fully prevent this, so read the arguments on the approval card before you allow a call, and select only the tools an agent needs.
- **Local storage.** Saved agents, the tools you allowed for them and the theme are kept in this browser's storage. Keys, sign-ins, values, conversations and images are kept in memory and are gone when the tab closes.
- **Signing out.** Sign out in a tool server's window to remove its sign-in now. Closing the tab removes every key and sign-in.
- **Where to type keys.** Enter keys only on a copy you built yourself or on the address your organization publishes. The Pages workflow below publishes to `https://<owner>.github.io/<repository>/`. AFM is open source, and a modified copy hosted elsewhere could capture keys.

## Security notes

- A production build writes a Content Security Policy into the page as a `<meta>` tag (defined in `csp.ts`), so it holds on any static host, including GitHub Pages, which cannot send response headers. It allows scripts and styles only from the app itself, starts workers only from `blob:` addresses, and lets the page call only the two model providers and the proxy address directly. A `<meta>` tag cannot carry `frame-ancestors`, so the page also refuses to start inside a frame. A host that can send response headers should send the policy as a header too.
- The secret store never uses browser storage.
- The worker releases a key only for the exact address or provider it was entered for, and refuses a variable that is used both as a key and as a value.

## Deploy

The build is plain static files in `dist/`.

```sh
pnpm build
```

The `Browser-based Interpreter Pages` workflow (manual, `main` only) builds the app and publishes it to GitHub Pages. Set these repository variables first:

| Variable | Used for |
|---|---|
| `MCP_PROXY_URL` | `VITE_MCP_PROXY_URL` |
| `MCP_PROXY_SESSION_HEADER` | `VITE_MCP_PROXY_SESSION_HEADER` (optional) |
| `OAUTH_CLIENT_ID_URL` | `VITE_OAUTH_CLIENT_ID_URL` (optional) |

The `Browser-based Interpreter Dependency Audit` workflow runs every day. It fails on a high or critical vulnerability and opens or updates one issue that names the code owners.

## Project Structure

| Folder | What is in it |
|---|---|
| `src/app` | Routing shell, the three contexts (theme, saved agents, history), error boundary |
| `src/core` | Logic with no React: agent file handling, chat state, images, share links, MCP, OAuth, the worker runtime, secrets, setup checks, storage |
| `src/features` | One folder per screen: chat, editor, model, setup, share, start, tools, workspace |
| `src/ui` | Small shared pieces: hooks, inputs, marks, tooltips, dialog frame |
| `src/worker-client` | The hook that owns the worker and speaks its message protocol |
| `src/styles` | Stylesheets |
| `src/test-support` | A fake model and fake tool servers, used only by the tests |
| `csp.ts` | The Content Security Policy written into the production page |

## Testing

```sh
pnpm check      # typecheck and tests
pnpm test       # tests only
```

## License

Apache License 2.0. See the repository [LICENSE](../LICENSE).
