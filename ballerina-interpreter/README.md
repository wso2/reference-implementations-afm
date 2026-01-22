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

## Running with Docker

```bash
# Build the image
docker build -t afm-ballerina-interpreter .

# Run with an AFM file mounted
docker run -v /path/to/agent.afm.md:/app/agent.afm.md \
  -e afmFilePath=/app/agent.afm.md \
  -p 8085:8085 \
  afm-ballerina-interpreter
```

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
├── modules/
│   └── everit.validator/       # JSON Schema validation
├── tests/                      # Test files
├── resources/
│   └── chat-ui.html            # Web chat UI template
├── Ballerina.toml              # Project configuration
└── Dockerfile                  # Container build
```

## License

Apache License 2.0
