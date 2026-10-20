# AFM LangChain Backend

[![PyPI version](https://img.shields.io/pypi/v/afm-langchain.svg)](https://pypi.org/project/afm-langchain/)
[![Python version](https://img.shields.io/pypi/pyversions/afm-langchain.svg)](https://pypi.org/project/afm-langchain/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

LangChain execution backend for [Agent-Flavored Markdown (AFM)](https://github.com/wso2/agent-flavored-markdown) agents.

This package implements the `AgentRunner` protocol from `afm-core`, providing LLM orchestration using the LangChain framework.

## Features

- **AgentRunner Protocol Implementation**: Pluggable backend for AFM agents
- **LLM Provider Support**: OpenAI, Anthropic, Google Gemini and Ollama models
- **MCP Tool Integration**: Connect external tools via Model Context Protocol
- **Conversation Management**: Session history and state management
- **Plugin Registration**: Auto-discovered via Python entry points

## Installation

This package is typically installed as part of `afm-cli`. For LangChain-specific use:

```bash
pip install afm-langchain
```

## Supported Providers

### OpenAI

```yaml
model:
  provider: openai
  name: gpt-4o  # or other OpenAI models
```

Requires: `OPENAI_API_KEY` environment variable

### Anthropic

```yaml
model:
  provider: anthropic
  name: claude-sonnet-4-5  # or other Claude models
```

Requires: `ANTHROPIC_API_KEY` environment variable

### Google Gemini

```yaml
model:
  provider: gemini
  name: gemini-2.5-flash  # or other Gemini models
```

Requires: `GOOGLE_API_KEY` environment variable, or an `authentication` block

To use Vertex AI instead of the Gemini Developer API, set the project, and optionally the location, under `provider_options`:

```yaml
model:
  provider: gemini
  name: gemini-2.5-flash
  provider_options:
    project: your-gcp-project-id
    location: us-central1  # optional, defaults to GOOGLE_CLOUD_LOCATION or global
```

Vertex AI authenticates with [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials), for example through `gcloud auth application-default login` or the `GOOGLE_APPLICATION_CREDENTIALS` environment variable. The `authentication` field is not supported in this mode.

### Ollama

```yaml
model:
  provider: ollama
  name: llama3.1  # or other local models
  url: http://localhost:11434  # optional
```

Requires: a running [Ollama](https://ollama.com) server with the model pulled (for example `ollama pull llama3.1`). No API key is needed. Agents that use tools or skills need a model with tool-calling support. If `name` is omitted, `llama3.1` is used.

## Development

### Setup

This project uses [uv](https://docs.astral.sh/uv/) for dependency management.

```bash
# Clone the repository
git clone https://github.com/wso2/reference-implementations-afm.git
cd python-interpreter

# Install dependencies
uv sync

# Activate the virtual environment
source .venv/bin/activate
```

### Running Tests

```bash
# Run afm-langchain tests
uv run pytest packages/afm-langchain/tests/

# Run with coverage
uv run pytest packages/afm-langchain/tests/ --cov=afm_langchain
```

### Code Quality

```bash
# Format code
uv run ruff format

# Lint code
uv run ruff check
```

### Project Structure

```text
packages/afm-langchain/src/afm_langchain/
├── __init__.py
├── backend.py          # LangChainRunner implementation
├── model_factory.py    # LLM provider factory
├── mcp_manager.py      # MCP tool management
└── tools_adapter.py    # Tool calling adapter
```

## Usage

The LangChain backend is automatically registered and used when you run an AFM agent:

```python
from afm.runner import get_runner

# Get the LangChain runner
runner = get_runner("langchain")

# Run an agent
result = await runner.run(agent, user_input)
```

## Documentation

For comprehensive documentation, see the [project README](https://github.com/wso2/reference-implementations-afm/tree/main/python-interpreter).

## License

Apache-2.0
