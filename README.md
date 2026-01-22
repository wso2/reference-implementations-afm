# AFM Reference Implementations

Reference implementations for [Agent-Flavored Markdown (AFM)](https://github.com/wso2/agent-flavored-markdown).

## Implementations

| Implementation | Language/Framework | Status |
|----------------|-------------------|--------|
| [ballerina-interpreter](./ballerina-interpreter) | Ballerina | Active |
| langchain-interpreter | Python/LangChain | Planned |

## Repository Structure

```
reference-implementations-afm/
├── ballerina-interpreter/   # Ballerina-based AFM interpreter
└── .github/workflows/       # CI/CD (path-filtered per implementation)
```

## Getting Started

Each implementation has its own README with setup and usage instructions. See the implementation directories for details.

## AFM Specification

See the [AFM Specification](https://github.com/wso2/agent-flavored-markdown).

## Contributing

Contributions are welcome! When adding a new implementation:

1. Create a new directory: `{language/framework}-{type}/` (e.g., `langchain-interpreter/`)
2. Add a path-filtered workflow in `.github/workflows/`
3. Include a README with setup and usage instructions
4. Follow the AFM specification for compatibility

## License

See individual implementation directories for license information.
