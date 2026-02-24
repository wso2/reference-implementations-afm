# AFM Python Interpreter

The AFM Python Interpreter is the shared runtime for Python-based [Agent-Flavored Markdown (AFM)](https://github.com/wso2/agent-flavored-markdown) implementations. It provides a modular, plugin-based architecture that supports multiple execution backends, with LangChain provided as the reference backend.

## Features

- **Pluggable execution backends** - Support for multiple LLM frameworks via the `AgentRunner` protocol (LangChain included as reference implementation)
- **Support for all interface types:**
  - Console chat (interactive CLI)
  - Web chat (HTTP API + optional UI)
  - Webhook (WebSub-based event handling)
- **Multi-interface agents** - run multiple interfaces simultaneously
- **MCP support** for tools (Model Context Protocol)
- **Validation** - dry-run mode to validate AFM definitions

## Prerequisites

- [Python](https://www.python.org/) 3.11 or later.
- [uv](https://docs.astral.sh/uv/) for dependency management.
- [Docker](https://www.docker.com/) (optional, for running via containers).

## Quick Start

### Via pip

```bash
pip install afm-cli
export OPENAI_API_KEY="your-api-key-here"
afm run path/to/agent.afm.md
```

### Via uv (development)

```bash
export OPENAI_API_KEY="your-api-key-here"
uv run afm path/to/agent.afm.md
```

## Configuration

Configuration via environment variables or CLI options:

- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. (Required based on provider)
- HTTP port can be set via `-p` or `--port` (default: 8000)

## Running with Docker

The Docker image bundles the LangChain execution backend.

```bash
# Using the pre-built image
docker run -v $(pwd)/path/to/agent.afm.md:/app/agent.afm.md \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -p 8000:8000 \
  ghcr.io/wso2/afm-langchain-interpreter:latest run /app/agent.afm.md

# Or build locally
docker build -t afm-langchain-interpreter .
```

## Testing

```bash
uv run pytest
```

## Project Structure

This is a uv workspace with three packages:

```text
python-interpreter/
├── packages/
│   ├── afm-core/          # Core: parser, CLI, models, interfaces, protocols
│   │   ├── src/afm/
│   │   └── tests/
│   ├── afm-langchain/     # LangChain execution backend
│   │   ├── src/afm_langchain/
│   │   └── tests/
│   └── afm-cli/           # User-facing metapackage
├── Dockerfile             # Container build
├── pyproject.toml         # Workspace configuration
└── uv.lock                # Dependency lock file
```

## License

Apache-2.0
