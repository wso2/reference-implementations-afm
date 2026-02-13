# AFM Python Interpreter

A LangChain-based reference implementation of an interpreter for [Agent-Flavored Markdown (AFM)](https://github.com/wso2/agent-flavored-markdown) files.

## Features

- **Support for all interface types:**
  - Console chat (interactive CLI)
  - Web chat (HTTP API + optional UI)
  - Webhook (WebSub-based event handling)
- **Multi-interface agents** - run multiple interfaces simultaneously
- **MCP support** for tools (Model Context Protocol)
- **Validation** - dry-run mode to validate AFM definitions

## Prerequisites

- [Python](https://www.python.org/) 3.12 or later.
- [uv](https://docs.astral.sh/uv/) for dependency management.
- [Docker](https://www.docker.com/) (optional, for running via containers).

## Quick Start

```bash
# Set your API Key
export OPENAI_API_KEY="your-api-key-here"

# Run with an AFM file using uv
uv run afm path/to/agent.afm.md
```

## Configuration

Configuration via environment variables or CLI options:

- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. (Required based on provider)
- HTTP port can be set via `-p` or `--port` (default: 8000)

## Running with Docker

```bash
# Build the image
docker build -t afm-langchain-interpreter .

# Run with an AFM file mounted and API key
docker run -v $(pwd)/path/to/agent.afm.md:/app/agent.afm.md \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -p 8000:8000 \
  afm-langchain-interpreter afm /app/agent.afm.md
```

## Testing

```bash
uv run pytest
```

## Project Structure

```text
python-interpreter/
├── src/afm/
│   ├── interfaces/        # Interface implementations (console, web, webhook)
│   ├── tools/             # Tool support (MCP server)
│   ├── resources/         # Static assets (web UI)
│   ├── agent.py           # Core agent logic
│   ├── cli.py             # CLI entry point
│   ├── parser.py          # AFM file parsing
│   ├── models.py          # Model configuration
│   ├── providers.py       # LLM provider handling
│   └── templates.py       # Prompt templates
├── tests/                 # Unit and integration tests
├── Dockerfile             # Container build
├── pyproject.toml         # Python project configuration
└── uv.lock                # Dependency lock file
```

## License

Apache-2.0
