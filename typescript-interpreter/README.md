# TypeScript Interpreter

TypeScript packages for parsing and running [Agent-Flavored Markdown (AFM)](https://wso2.github.io/agent-flavored-markdown/) agents.

The engine handles parsing, validation, variable resolution, browser-oriented setup planning, and streamed agent turns. Adapters connect it to model providers, authentication, secrets, and tools. The consuming application supplies the user interface and runtime integration; this workspace does not include a web application or an MCP relay.

## Packages

| Package | Directory | Purpose |
|---|---|---|
| `@afm/engine` | `packages/engine` | Agent parsing, validation, setup planning, and execution |
| `@afm/adapter-auth` | `packages/adapters/auth` | MCP OAuth discovery, grants, and token handling |
| `@afm/adapter-model` | `packages/adapters/model` | OpenAI and Anthropic model adapters |
| `@afm/adapter-secret` | `packages/adapters/secret` | A config secret provider |
| `@afm/adapter-tool` | `packages/adapters/tool` | MCP HTTP tools, file tools, filtering, and namespacing |

## Architecture

Dependencies point one way: the adapters depend on the engine, and `@afm/adapter-tool` also depends on `@afm/adapter-auth`. The engine depends on no adapter. Each module has one job, and each test file sits beside the module it covers.

| Package | Modules |
|---|---|
| `@afm/engine` | `parse` (frontmatter, role, instructions), `schema` (agent metadata, authentication), `variables` (variable resolution, secret usage, address checks), `load` (`loadAfm` and the browser plan), `loop` (the agent turn), `errors` (error classes, rate limits), `types` (ports, messages, record guards) |
| `@afm/adapter-auth` | `discovery` (RFC 9728 and 8414 discovery, sign-in server), `authorization-code` (provider, authorize URL, token exchange), `session`, `machine-grants`, `utils` (encoding, address checks, token requests) |
| `@afm/adapter-model` | `providers` (OpenAI, Anthropic, key check), `convert` (messages, tools, events), `stream` (streaming, continuation cache) |
| `@afm/adapter-tool` | `mcp` (HTTP port, result mapping), `mcp-auth`, `files`, `tool-ports` (composite, filtered, in-page and namespaced ports) |
| `@afm/adapter-secret` | the config secret provider |

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

The packages are private workspace packages and are not published to npm. Their entry points export TypeScript source, so consumers need tooling that supports TypeScript and the browser/Web APIs used by the selected adapters.

Within this workspace, packages use `workspace:*` dependencies. Separate consumers must explicitly resolve the required packages and their internal dependencies; copying only one adapter is not sufficient.

A consuming application normally:

1. Provides a `SecretPort` and loads agent content with `loadAfm`.
2. Creates model and tool adapters from the loaded configuration. A model port remembers the provider's own state between the turns of one conversation, so each conversation gets its own model port.
3. Supplies conversation messages, a permission broker, and optional execution budgets to `runAgentTurn`. The loop does not read `max_iterations` from the agent file by itself: pass `loaded.metadata.max_iterations` as `budget.maxIterations` to apply it, otherwise the loop stops after `DEFAULT_MAX_ITERATIONS` (10) iterations.
4. Handles the streamed loop events, cancellation, and application state.

OAuth2 machine grants such as `client_credentials` send the client id and secret in an HTTP Basic header, form-encoded as RFC 6749 section 2.3.1 requires. A token server that does not decode them can receive them in the request body instead: set `credential_bearer: post_body`.

The public exports in each package's `src/index.ts` and the colocated tests describe the available interfaces. The existing browser-oriented planning behavior remains in the engine; separating the application does not add CLI or server interfaces.

## Security responsibilities

- Keep credentials out of source control, logs, and generated error messages.
- The MCP adapter does not send credentials (headers, API keys, tokens) to an `http://` address, whether the server or the proxy, unless the address is `localhost`, `127.x.x.x` or `[::1]`; the browser plan reports such a server as blocked. A server with no credentials is not affected. The agent file schema still accepts `http://` addresses, as the specification does.
- Supply an appropriate `PermissionBroker`; `allowAllPermissions` explicitly approves every tool call and is not a substitute for a permission policy.
- Enforce application-level policies for secret destinations, network access, storage, and user consent in the consuming runtime.
- Decide where the sign-in refresh token is kept. A session holds its access token in memory and writes the refresh token to the store you pass in; it does not read the token back by itself, so after a reload the person signs in again.
- Preserve cancellation and execution budgets when integrating the agent loop.
- Dependency build scripts are restricted, with esbuild explicitly allowed. The workspace also retains overrides for patched transitive dependencies.

Application features such as worker isolation, Content-Security-Policy headers, OAuth callback UI, and MCP relay deployment belong to the consuming application, not these packages.

## License

Apache License 2.0. See the repository [LICENSE](../LICENSE).
