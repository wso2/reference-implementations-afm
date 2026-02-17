# AFM CLI

[![PyPI version](https://img.shields.io/pypi/v/afm-cli.svg)](https://pypi.org/project/afm-cli/)
[![Python version](https://img.shields.io/pypi/pyversions/afm-cli.svg)](https://pypi.org/project/afm-cli/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

A command-line interface for running [Agent-Flavored Markdown (AFM)](https://github.com/wso2/agent-flavored-markdown) agents.

This package provides everything you need to run AFM agents, including:
- **afm-core**: Parser, validation, and interface implementations
- **afm-langchain**: LangChain-based execution backend with support for OpenAI and Anthropic

## Installation

```bash
pip install afm-cli
```

## Quick Start

### 1. Set your API key

```bash
export OPENAI_API_KEY="your-api-key-here"
# or
export ANTHROPIC_API_KEY="your-api-key-here"
```

### 2. Create an AFM file

Create a file named `agent.afm.md`:

```markdown
---
name: Friendly Assistant
interfaces:
  - type: consolechat
model:
  provider: openai
  name: gpt-4o

---
# Role
You are a helpful and friendly AI assistant.

# Instructions
- Be concise but thorough in your responses
- If you don't know something, say so honestly
- Always be polite and professional
```

### 3. Run the agent

```bash
afm run agent.afm.md
```

This will start an interactive console chat with your agent.

## Usage

### `afm run <file>`

Run an AFM agent file and start its configured interfaces.

```bash
# Run with default settings
afm run agent.afm.md

# Run on a specific port (for web interfaces)
afm run agent.afm.md --port 8080
```

### `afm validate <file>`

Validate an AFM file without running it.

```bash
afm validate agent.afm.md
```

### `afm framework list`

List available execution backends.

```bash
afm framework list
```

## Configuration

### Environment Variables

- `OPENAI_API_KEY` - Required for OpenAI models
- `ANTHROPIC_API_KEY` - Required for Anthropic models

### CLI Options

- `-p, --port PORT` - Port for web interfaces (default: 8000)
- `--help` - Show help message

## Features

### Interface Types

AFM agents can expose multiple interfaces simultaneously:

- **consolechat**: Interactive terminal-based chat (default)
- **webchat**: HTTP API with built-in web UI
- **webhook**: Webhook endpoint for event-driven agents

### MCP Tool Support

Agents can use external tools via Model Context Protocol (MCP).

For more examples and detailed documentation, see [AFM Examples](https://wso2.github.io/agent-flavored-markdown/examples/).

## Docker

You can also run agents using Docker:

```bash
# Build the image
docker build -t afm-langchain-interpreter .

# Run with an AFM file mounted
docker run -v $(pwd)/agent.afm.md:/app/agent.afm.md \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  -p 8000:8000 \
  afm-langchain-interpreter afm /app/agent.afm.md
```

## Documentation

For more detailed documentation, see the [project README](https://github.com/wso2/reference-implementations-afm/tree/main/python-interpreter).

## License

Apache-2.0
