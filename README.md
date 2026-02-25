# AFM Reference Implementations

Reference implementations for [Agent-Flavored Markdown (AFM)](https://wso2.github.io/agent-flavored-markdown/).

## Implementations

### Ballerina

A Ballerina-based AFM interpreter.

- **Source:** [`ballerina-interpreter/`](./ballerina-interpreter/)
- **Docker Image:** `ghcr.io/wso2/afm-ballerina-interpreter`
- **[Getting Started →](./ballerina-interpreter/)**

### LangChain

A Python-based AFM interpreter using LangChain for agent execution.

- **Source:** [`python-interpreter/packages/afm-langchain`](./python-interpreter/packages/afm-langchain/)
- **PyPI:** [`afm-langchain`](https://pypi.org/project/afm-langchain/)
- **Docker Image:** `ghcr.io/wso2/afm-langchain-interpreter`
- **[Getting Started →](./python-interpreter/)**

> [!NOTE]
> Python-based implementations share a common runtime and CLI ([`afm-core`](./python-interpreter/packages/afm-core/)) that make it easy to switch between backends. LangChain is currently the supported backend; support for additional frameworks is planned.

## Repository Structure

```
reference-implementations-afm/
├── ballerina-interpreter/   # Ballerina-based AFM interpreter
├── python-interpreter/      # Python-based AFM interpreters (plugin-based)
└── .github/workflows/       # CI/CD
```

## Contributing

Contributions are welcome!

### Adding a New Implementation (New Language or Framework)

To add an interpreter in a new language or framework:

1. Create a new directory: `{language/framework}-{type}/` (e.g., `go-interpreter/`)
2. Add a path-filtered workflow in `.github/workflows/`
3. Include a README with setup and usage instructions
4. Follow the [AFM Specification](https://wso2.github.io/agent-flavored-markdown/specification/) for compatibility

### Adding a New Python Execution Backend (Plugin)

The Python interpreter uses a plugin-based architecture. New execution backends should be contributed as packages inside [`python-interpreter/packages/`](./python-interpreter/packages/).

To add a new Python backend:

1. Create a new package under `python-interpreter/packages/` and add it to the `uv` workspace
2. Implement the `AgentRunner` protocol from [`afm-core`](./python-interpreter/packages/afm-core/)
3. Register your backend via the `afm.runner` entry point in your `pyproject.toml`:
   ```toml
   [project.entry-points."afm.runner"]
   your-backend = "your_package.module:YourRunnerClass"
   ```
4. Use [`afm-langchain`](./python-interpreter/packages/afm-langchain/) as a reference implementation
5. Include a README and tests for your package

## License

Apache License 2.0
