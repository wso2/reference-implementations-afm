# AFM Browser-based Interpreter

A web app that runs an [AFM](https://wso2.github.io/agent-flavored-markdown/) agent in the browser. Write or paste an agent file, set up its model key and tools, then chat with it. The agent runs in a web worker inside the page; there is no server component to deploy, except an optional proxy for HTTP tool servers.

## What it does

- Edit an agent file in a simple editor, with a raw AFM view next to it, and see what is wrong before running.
- Check everything the agent needs in one step: the model key, MCP tool servers and their sign-ins.
- Chat with the running agent. Attach PDF, Markdown or text files, and approve or remember tool permissions.
- Share an agent as a link, or open one from a link or a raw file address.
- Keys are kept in memory for the tab and are gone when it closes. A key typed for one tool server is only ever sent to that server's address.

## Run it

You need Node.js 24 and pnpm 11 (`packageManager` pins the version). The two `@afm/*` packages (`engine` and `runtime`) are installed from the `typescript-interpreter/` folder next to this one (`file:../typescript-interpreter/packages/*`), so work from a checkout of the whole repository. If that folder is not there yet, it comes from #42, the TypeScript interpreter.

```sh
cd browser-based-interpreter
pnpm install
pnpm dev        # http://localhost:5173
pnpm check      # typecheck and tests
pnpm build      # production files in dist/
```

HTTP MCP servers cannot be reached directly from a page, so the app refuses to connect one without a proxy. Copy `.env.example` to `.env.local` and set `VITE_MCP_PROXY_URL` to a running MCP proxy (a separate service).

## Layout

| Folder | What is in it |
|---|---|
| `src/app` | Routing shell, the four contexts (theme, saved agents, history, tool permissions), error boundary |
| `src/core` | Logic with no React: agent file handling, chat state, files, share links, MCP, OAuth, the worker runtime, secrets, setup checks, storage |
| `src/features` | One folder per screen: chat, editor, model, setup, share, start, tools, workspace |
| `src/ui` | Small shared pieces: hooks, inputs, marks, tooltips, dialog frame |
| `src/worker-client` | The hook that owns the worker and speaks its message protocol |
| `src/styles` | Stylesheets |

## Using AFM Safely

- **Keys.** Type a key into a key box, never into the agent file: the file keeps only a `${env:NAME}` reference. A key is sent only to the server address it was entered for, and a model key only to OpenAI or Anthropic. Do not put keys in a server address: addresses pass through the MCP proxy and its gateway logs. The share panel warns if a key is written into the file.
- **Shared agents.** An agent opened from a link or a file shows a screen first: its model, each tool server and its host, and the keys it needs. Its Permissions button lets you select, by name, which of the tools the file lists may run without asking; every other tool asks first, in the chat. Open it in the builder to read it before it runs, and run only agents from people you trust, because the author decides what the agent is told to do.
- **Tool approvals.** When a tool needs permission, a small card appears in the chat under the tool call. It shows the tool, the host it goes to and the full arguments, with three choices: Allow, Always allow and Deny. Nothing runs until you decide. "Always allow" selects the tool in Permissions (Settings, or the first window of an agent from outside), so it is visible, can be undone there, and is saved with the agent. Stop denies a waiting question.
- **Prompt injection.** Pages, documents and tool results the agent reads can contain instructions that try to steer it. No model can fully prevent this, so read the arguments on the approval card before you allow a call, and select only the tools an agent needs.
- **Local storage.** Saved agents, the tools you selected for them and the theme are kept in this browser's storage. Keys, sign-ins, conversations and attached files are kept in memory and are gone when the tab closes.
- **Signing out.** Sign out in a tool server's window to remove its sign-in now. Closing the tab removes every key and sign-in.
- **Where to type keys.** Enter keys only on the official AFM address. AFM is open source, and a modified copy hosted elsewhere could capture them.

## Security notes

- `public/staticwebapp.config.json` holds the security headers. The content security policy allows scripts only from the app itself, allows styles only from the app's own files, starts workers only from `blob:` addresses, and lists the only sites the page may call directly (the two model providers); everything else goes through the MCP proxy. A production build also writes the policy into the page as a `<meta>` tag (without the header-only parts), so it holds on any static host, including GitHub Pages; a host that can send response headers should send the whole set in this file.
- `vite.config.ts` carries a one-line fix for the MCP schema validator, so that it starts inside a blob worker when the page's address has a port.
- The secret store never uses browser storage. The tools you select in Permissions are saved with the agent, as names only.

## Deploy

The build is plain static files. The repository's `Browser-based Interpreter Pages` workflow (manual) publishes it to GitHub Pages; set the repository variable `MCP_PROXY_URL` first.
