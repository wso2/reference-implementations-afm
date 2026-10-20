# AFM Ballerina Interpreter

A Ballerina-based interpreter for [Agent-Flavored Markdown (AFM)](https://github.com/wso2/agent-flavored-markdown) files.

## Features

- **Support for all interface types:**
  - Console chat (interactive CLI)
  - Web chat (HTTP API + optional UI)
  - Webhook (WebSub-based event handling)
- **Multi-interface agents** - run multiple interfaces simultaneously
- **MCP support** for tools (e.g., streamable HTTP)
- **JSON Schema validation** for inputs/outputs

## Prerequisites

- [Ballerina](https://ballerina.io/) 2201.12.10 or later. Alternatively, use the Docker image.

## Quick Start

```bash
# Build
bal build

# Run with an AFM file
bal run -- path/to/agent.afm.md
```

## Configuration

Configuration via environment variables or `Config.toml`:

```toml
port = 8085
afmFilePath = "path/to/agent.afm.md"
```

The AFM file path can also be passed as a command-line argument.

## Model Providers

The model is configured via the `model` block in the AFM frontmatter. Supported providers:

| `provider` | Required fields | Credentials |
|---|---|---|
| _(no `model` block)_ | — | `WSO2_MODEL_PROVIDER_TOKEN` env var (WSO2 default model) |
| `wso2` | — | `authentication` (bearer) |
| `openai` | `name` | `authentication` (api-key) |
| `anthropic` | `name` | `authentication` (api-key) |
| `ollama` | `name` | none (optional `url`, defaults to `http://localhost:11434`) |
| `gemini` | `name`, `provider_options.project` | Google credentials file via `GOOGLE_APPLICATION_CREDENTIALS` |

Provider-specific settings go under `provider_options`. Keys that the selected provider does not support are rejected.

### Gemini (Vertex AI)

The Ballerina interpreter runs Gemini on Vertex AI only. Set the project, and optionally the location, under `provider_options`:

```yaml
model:
  provider: gemini
  name: gemini-2.5-flash
  provider_options:
    project: your-gcp-project-id
    location: us-central1        # optional, defaults to global
```

The `authentication` field is not used. Credentials are read from the file referenced by the `GOOGLE_APPLICATION_CREDENTIALS` environment variable, which can be either:

- **Application Default Credentials** (`authorized_user`), created by `gcloud auth application-default login`.
- **A service account key** (`service_account`), a downloaded JSON key file.

Other credential types, such as `external_account` files or credentials provided by the metadata server (for example workload identity on GKE or Cloud Run), are not supported.

**Local development:**

```bash
gcloud auth application-default login
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/gcloud/application_default_credentials.json"
bal run -- agent-vertex.afm.md
```

**Docker:** mount the credentials file read-only and point the environment variable at it. The file must be readable by the container user (UID 10014).

```bash
docker run -it --rm \
  -v $(pwd)/agent-vertex.afm.md:/app/agent.afm.md \
  -v $HOME/.config/gcloud/application_default_credentials.json:/tmp/adc.json:ro \
  -e GOOGLE_APPLICATION_CREDENTIALS=/tmp/adc.json \
  afm-ballerina-interpreter /app/agent.afm.md
```

## Running with Docker

```bash
# Build the image
docker build -t afm-ballerina-interpreter .

# Run with an AFM file mounted
docker run -v /path/to/agent.afm.md:/app/agent.afm.md \
  -e afmFilePath=/app/agent.afm.md \
  -p 8085:8085 \
  afm-ballerina-interpreter

# Run with skills (mount the skills directory so the agent can discover them)
docker run -v /path/to/agent.afm.md:/app/agent.afm.md \
  -v /path/to/skills:/app/skills \
  -e afmFilePath=/app/agent.afm.md \
  -p 8085:8085 \
  afm-ballerina-interpreter
```

When using local skills, the `path` in the AFM file should be relative to the AFM file's location. For example, if the AFM file is at `/app/agent.afm.md` and skills are mounted at `/app/skills`, use `path: "./skills"` in the AFM file.

## Testing

```bash
bal test
```

## Project Structure

```
ballerina-interpreter/
├── main.bal                    # Entry point & interface orchestration
├── agent.bal                   # Agent creation & model configuration
├── parser.bal                  # AFM file parsing
├── types.bal                   # Type definitions
├── interface_console_chat.bal  # Console chat interface
├── interface_web_chat.bal      # Web chat HTTP API
├── interface_web_ui.bal        # Web chat UI
├── interface_webhook.bal       # Webhook/WebSub handler
├── skills.bal                  # Agent Skills discovery & toolkit
├── modules/
│   └── everit.validator/       # JSON Schema validation
├── tests/                      # Test files
├── resources/
│   └── chat-ui.html            # Web chat UI template
├── Ballerina.toml              # Project configuration
└── Dockerfile                  # Container build
```
