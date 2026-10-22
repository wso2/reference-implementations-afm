# AFM Browser-based Interpreter

A web app that runs an [AFM](https://wso2.github.io/agent-flavored-markdown/) agent in the browser. You can write or paste an agent file, set up its model key and share it as a link. Running the agent and chatting with it is not connected yet.

## What it does

- Edit an agent file in a simple editor, with a raw AFM view next to it, and see what is wrong before running.
- Share an agent as a link, or open one from a link or a raw file address.
- A key you enter is kept in memory for the tab and is gone when it closes.

## Run it

You need Node.js 24 and pnpm 11 (`packageManager` pins the version). The five `@afm/*` packages are installed from the `typescript-interpreter/` folder next to this one (`file:../typescript-interpreter/packages/*`), so work from a checkout of the whole repository. If that folder is not there yet, it comes from #42, the TypeScript interpreter.

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
| `src/features` | One folder per screen: editor, model, setup, share, start, workspace |
| `src/ui` | Small shared pieces: hooks, inputs, marks, tooltips, dialog frame |
| `src/worker-client` | The hook that owns the worker and speaks its message protocol |
| `src/styles` | Stylesheets |
