# TypeScript Interpreter

TypeScript packages for parsing and running [Agent-Flavored Markdown (AFM)](https://wso2.github.io/agent-flavored-markdown/) agents.

The engine reads an agent file: parsing, validation, variable resolution and browser-oriented setup planning. The runtime runs the agent on the [Vercel AI SDK](https://ai-sdk.dev): the streamed agent turn, model providers, MCP tools, file tools, secrets and OAuth sign-in. The consuming application supplies the user interface and runtime integration; this workspace does not include a web application or an MCP relay.

## Packages

| Package | Directory | Purpose |
|---|---|---|
| `@afm/engine` | `packages/engine` | Agent file parsing, validation, variables and setup planning |
| `@afm/runtime` | `packages/runtime` | The agent turn, models, MCP and file tools, secrets and OAuth sign-in, on the AI SDK |

## Architecture

The runtime depends on the engine. The engine depends on neither the runtime nor the AI SDK. Each module has one job, and each test file sits beside the module it covers.

| Package | Modules |
|---|---|
| `@afm/engine` | `parse` (frontmatter, role, instructions), `schema` (agent metadata, authentication), `variables` (variable resolution, secret usage, address checks), `load` (`loadAfm` and the browser plan), `errors` (error classes), `types` (secret port, record guards) |
| `@afm/runtime` | `run` (the agent turn: `streamText` with step, token and time limits), `model` (OpenAI, Anthropic, key check), `mcp` (one MCP server through the AI SDK MCP client, with its tool filter), `tool-guard` (permission question, one call at a time, result size), `tool-names` (`server__tool` names), `toolbox` (many servers as one tool set), `files` (file tools), `mcp-auth` (headers for a tool server), `secret` (config secret provider), `auth/` (OAuth discovery for setup, and the sign-in session built on the AI SDK's `auth()`) |

## Development

Use Node.js 24 and pnpm 11.9.0, matching CI and the `packageManager` field.

From the repository root:

```sh
cd typescript-interpreter
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

`pnpm run check` runs typechecking and tests together. `pnpm run test:watch` starts the test watcher. Tests are colocated with the package source files.

The tests also load six example agents from the AFM specification (`packages/engine/fixtures/agents/`) and check that the engine accepts them.

### Docker

The `Dockerfile` runs the same checks as CI, with the same Node.js (24) and pnpm (11.9.0), so they behave the same on any machine. It checks the code; it does not run agents.

```sh
cd typescript-interpreter
docker build -t afm-typescript-interpreter .
```

The build installs the dependencies, then runs the typecheck and the tests with the network switched off. It fails if a check fails or if a test needs the internet. It needs BuildKit, which is the default builder from Docker 23; with an older Docker, set `DOCKER_BUILDKIT=1`. To run the checks again in the built image:

```sh
docker run --rm --network none afm-typescript-interpreter
```

`docker compose run --rm check` runs the checks in the image, building it first if it does not exist yet; after changing files, run `docker compose build check` first. To get the workspace without the checks, for example to open a shell, build the `dev` stage:

```sh
docker build --target dev -t afm-typescript-interpreter:dev .
docker run --rm -it afm-typescript-interpreter:dev bash
```

## Using the packages

The packages are private workspace packages and are not published to npm. Their entry points export TypeScript source, so consumers need tooling that supports TypeScript and the browser/Web APIs the runtime uses.

Within this workspace, packages use `workspace:*` dependencies. Separate consumers must resolve both packages: the runtime needs the engine.

A consuming application normally:

1. Provides a `SecretPort` and loads agent content with `loadAfm`.
2. Creates a model with `createOpenAIModel` or `createAnthropicModel` (an AI SDK `LanguageModel`), and tool sources with `mcpServerTools` and `fileToolSource`. A tool source is built with a guard from `createToolGuard(permissionBroker)`, so every tool call asks the broker first, one call at a time. `createToolbox` joins the sources into one tool set and refuses two tools with the same name.
3. Supplies the conversation (`ModelMessage[]`), the tool set and optional limits to `runAgentTurn`. The loop does not read `max_iterations` from the agent file by itself: pass `loaded.metadata.max_iterations` as `budget.maxIterations` to apply it, otherwise the loop stops after `DEFAULT_MAX_ITERATIONS` (10) steps. A rate limit from the model provider is retried by the AI SDK, up to four times, before any output.
4. Handles the streamed loop events, cancellation, and application state.

The public exports in each package's `src/index.ts` and the colocated tests describe the available interfaces. The existing browser-oriented planning behavior remains in the engine; separating the application does not add CLI or server interfaces.

## Security responsibilities

- Keep credentials out of source control, logs, and generated error messages.
- The MCP client does not send credentials (headers, API keys, tokens) to an `http://` address, whether the server or the proxy, unless the address is `localhost`, `127.x.x.x` or `[::1]`; the browser plan reports such a server as blocked. A server with no credentials is not affected. The agent file schema still accepts `http://` addresses, as the specification does.
- Supply an appropriate `PermissionBroker`. It decides every tool call; the runtime has no "allow all" broker.
- Enforce application-level policies for secret destinations, network access, storage, and user consent in the consuming runtime.
- Decide where the sign-in refresh token is kept. A session holds its access token in memory and writes the refresh token to the store you pass in; it does not read the token back by itself, so after a reload the person signs in again.
- Preserve cancellation and execution budgets when integrating the agent loop.
- Dependency build scripts are restricted, with esbuild explicitly allowed. The workspace also retains overrides for patched transitive dependencies.

Application features such as worker isolation, Content-Security-Policy headers, OAuth callback UI, and MCP relay deployment belong to the consuming application, not these packages.

## License

Apache License 2.0. See the repository [LICENSE](../LICENSE).
