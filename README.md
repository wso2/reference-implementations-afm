# AFM Reference Implementations

Reference implementations for [Agent-Flavored Markdown (AFM)](https://wso2.github.io/agent-flavored-markdown/).

## Implementations

| Implementation | Language/Framework | Status |
|----------------|-------------------|--------|
| [ballerina-interpreter](./ballerina-interpreter) | Ballerina | Active |
| [langchain-interpreter](./langchain-interpreter) | Python/LangChain | Active |

## Repository Structure

```
reference-implementations-afm/
├── ballerina-interpreter/   # Ballerina-based AFM interpreter
├── langchain-interpreter/   # LangChain-based AFM interpreter
└── .github/workflows/       # CI/CD (path-filtered per implementation)
```

## Getting Started

Each implementation has its own README with setup and usage instructions. See the implementation directories for details.

## Contributing

Contributions are welcome! When adding a new implementation:

1. Create a new directory: `{language/framework}-{type}/` (e.g., `langchain-interpreter/`)
2. Add a path-filtered workflow in `.github/workflows/`
3. Include a README with setup and usage instructions
4. Follow the [AFM Specification](https://wso2.github.io/agent-flavored-markdown/specification/) for compatibility

## License

Apache License 2.0
