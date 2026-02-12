# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0


class AFMError(Exception):
    pass


class AFMParseError(AFMError):
    def __init__(self, message: str, line: int | None = None):
        self.line = line
        if line is not None:
            message = f"Line {line}: {message}"
        super().__init__(message)


class AFMValidationError(AFMError):
    def __init__(self, message: str, field: str | None = None):
        self.field = field
        if field is not None:
            message = f"Field '{field}': {message}"
        super().__init__(message)


class VariableResolutionError(AFMError):
    def __init__(self, variable: str, reason: str):
        self.variable = variable
        self.reason = reason
        super().__init__(f"Cannot resolve variable '${{{variable}}}': {reason}")


class TemplateError(AFMError):
    def __init__(self, message: str, template: str | None = None):
        self.template = template
        super().__init__(message)


class TemplateCompilationError(TemplateError):
    pass


class TemplateEvaluationError(TemplateError):
    pass


class JSONAccessError(AFMError):
    def __init__(self, message: str, path: str | None = None):
        self.path = path
        super().__init__(message)


class AgentError(AFMError):
    pass


class ProviderError(AgentError):
    def __init__(self, message: str, provider: str | None = None):
        self.provider = provider
        if provider is not None:
            message = f"Provider '{provider}': {message}"
        super().__init__(message)


class InputValidationError(AFMValidationError):
    def __init__(self, message: str, schema_path: str | None = None):
        self.schema_path = schema_path
        super().__init__(message, field="input")


class OutputValidationError(AFMValidationError):
    def __init__(self, message: str, schema_path: str | None = None):
        self.schema_path = schema_path
        super().__init__(message, field="output")


class InterfaceNotFoundError(AFMError):
    def __init__(self, interface_type: str, available: list[str]) -> None:
        self.interface_type = interface_type
        self.available = available
        super().__init__(
            f"Interface type '{interface_type}' not found. "
            f"Available: {available if available else ['consolechat (default)']}"
        )


class MCPError(AFMError):
    def __init__(self, message: str, server_name: str | None = None):
        self.server_name = server_name
        if server_name is not None:
            message = f"MCP server '{server_name}': {message}"
        super().__init__(message)


class MCPConnectionError(MCPError):
    pass


class MCPToolError(MCPError):
    def __init__(
        self, message: str, server_name: str | None = None, tool_name: str | None = None
    ):
        self.tool_name = tool_name
        if tool_name is not None:
            message = f"Tool '{tool_name}': {message}"
        super().__init__(message, server_name)


class MCPAuthenticationError(MCPError):
    pass
