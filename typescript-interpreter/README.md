# TypeScript Interpreter

TypeScript packages for parsing and running [Agent-Flavored Markdown (AFM)](https://wso2.github.io/agent-flavored-markdown/) agents.

The engine handles parsing, validation, variable resolution, browser-oriented setup planning, and streamed agent turns. Adapters connect it to model providers, authentication, secrets, and tools. The consuming application supplies the user interface and runtime integration; this workspace does not include a web application or an MCP relay.

## Packages

| Package | Directory | Purpose |
|---|---|---|
| `@afm/engine` | `packages/engine` | Agent parsing, validation, setup planning, and execution |
| `@afm/adapter-auth` | `packages/adapters/auth` | MCP OAuth discovery, grants, and token handling |
| `@afm/adapter-model` | `packages/adapters/model` | OpenAI and Anthropic model adapters |
| `@afm/adapter-secret` | `packages/adapters/secret` | Config, prompt, and chained secret providers |
| `@afm/adapter-tool` | `packages/adapters/tool` | MCP HTTP tools, file tools, filtering, and namespacing |

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

## Using the packages

The packages are private workspace packages and are not published to npm. Their entry points export TypeScript source, so consumers need tooling that supports TypeScript and the browser/Web APIs used by the selected adapters.

Within this workspace, packages use `workspace:*` dependencies. Separate consumers must explicitly resolve the required packages and their internal dependencies; copying only one adapter is not sufficient.

A consuming application normally:

1. Provides a `SecretPort` and loads agent content with `loadAfm`.
2. Creates model and tool adapters from the loaded configuration.
3. Supplies conversation messages, a permission broker, and optional execution budgets to `runAgentTurn`.
4. Handles the streamed loop events, cancellation, and application state.

The public exports in each package's `src/index.ts` and the colocated tests describe the available interfaces. The existing browser-oriented planning behavior remains in the engine; separating the application does not add CLI or server interfaces.

## Security responsibilities

- Keep credentials out of source control, logs, and generated error messages.
- Supply an appropriate `PermissionBroker`; `allowAllPermissions` explicitly approves every tool call and is not a substitute for a permission policy.
- Enforce application-level policies for secret destinations, network access, storage, and user consent in the consuming runtime.
- Preserve cancellation and execution budgets when integrating the agent loop.
- Dependency build scripts are restricted, with esbuild explicitly allowed. The workspace also retains overrides for patched transitive dependencies.

Application features such as worker isolation, Content-Security-Policy headers, OAuth callback UI, and MCP relay deployment belong to the consuming application, not these packages.

## License

Apache License 2.0. See the repository [LICENSE](../LICENSE).
