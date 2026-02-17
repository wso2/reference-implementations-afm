# AFM Core

[![PyPI version](https://img.shields.io/pypi/v/afm-core.svg)](https://pypi.org/project/afm-core/)
[![Python version](https://img.shields.io/pypi/pyversions/afm-core.svg)](https://pypi.org/project/afm-core/)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Core library for [Agent-Flavored Markdown (AFM)](https://github.com/wso2/agent-flavored-markdown) - providing parsing, validation, and interface implementations.

## Features

- **AFM File Parser**: Extracts YAML frontmatter and Markdown content (Role, Instructions sections)
- **Pydantic Models**: Type-safe validation of AFM schema for agents, interfaces, and tools
- **Interface Implementations**: Console chat, web chat, and webhook interfaces
- **AgentRunner Protocol**: Pluggable backend system for different execution frameworks
- **CLI Framework**: Entry point for the `afm` command with validation and run commands

## Installation

This package is typically installed as part of `afm-cli`. For development or custom integrations:

```bash
pip install afm-core
```

## Usage

```python
from afm.parser import parse_afm_file

# Parse an AFM file (returns an AFMRecord)
record = parse_afm_file("agent.afm.md")

# Access parsed data
print(f"Agent: {record.metadata.name}")
print(f"Model: {record.metadata.model.provider}/{record.metadata.model.name}")
print(f"Interfaces: {[i.type for i in record.metadata.interfaces]}")
print(f"Role: {record.role}")
print(f"Instructions: {record.instructions}")
```

## Development

### Setup

This project uses [uv](https://docs.astral.sh/uv/) for dependency management.

```bash
# Clone the repository
git clone https://github.com/wso2/reference-implementations-afm.git
cd python-interpreter

# Install dependencies
uv sync
```

### Running Tests

```bash
# Run all tests
uv run pytest packages/afm-core/tests/

# Run with coverage
uv run pytest packages/afm-core/tests/ --cov=afm
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
packages/afm-core/src/afm/
├── __init__.py
├── cli.py              # CLI entry point
├── exceptions.py       # Custom exceptions
├── models.py           # Pydantic models
├── parser.py           # AFM file parsing
├── runner.py           # AgentRunner protocol and runner utilities
├── schema_validator.py # Schema validation
├── templates.py        # Prompt templates
├── update.py           # Update checker
├── variables.py        # Variable substitution
└── interfaces/         # Interface implementations
    ├── __init__.py
    ├── base.py         # Interface utilities (get_interfaces, get_http_path)
    ├── console_chat.py
    ├── web_chat.py
    └── webhook.py
```

## Documentation

For comprehensive documentation, see the [project README](https://github.com/wso2/reference-implementations-afm/tree/main/python-interpreter).

## License

Apache-2.0
