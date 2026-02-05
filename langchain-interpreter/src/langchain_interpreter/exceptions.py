# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Custom exceptions for AFM parsing and validation."""


class AFMError(Exception):
    """Base exception for all AFM-related errors."""

    pass


class AFMParseError(AFMError):
    """Raised when AFM content cannot be parsed."""

    def __init__(self, message: str, line: int | None = None):
        self.line = line
        if line is not None:
            message = f"Line {line}: {message}"
        super().__init__(message)


class AFMValidationError(AFMError):
    """Raised when AFM content is syntactically valid but semantically invalid."""

    def __init__(self, message: str, field: str | None = None):
        self.field = field
        if field is not None:
            message = f"Field '{field}': {message}"
        super().__init__(message)


class VariableResolutionError(AFMError):
    """Raised when a variable cannot be resolved."""

    def __init__(self, variable: str, reason: str):
        self.variable = variable
        self.reason = reason
        super().__init__(f"Cannot resolve variable '${{{variable}}}': {reason}")


class TemplateError(AFMError):
    """Raised when there's an error in template compilation or evaluation."""

    def __init__(self, message: str, template: str | None = None):
        self.template = template
        super().__init__(message)


class TemplateCompilationError(TemplateError):
    """Raised when a template cannot be compiled."""

    pass


class TemplateEvaluationError(TemplateError):
    """Raised when a compiled template cannot be evaluated."""

    pass


class JSONAccessError(AFMError):
    """Raised when JSON field access fails."""

    def __init__(self, message: str, path: str | None = None):
        self.path = path
        super().__init__(message)


class AgentError(AFMError):
    """Base exception for agent execution errors."""

    pass


class AgentConfigError(AgentError):
    """Raised when agent configuration is invalid."""

    def __init__(self, message: str, config_key: str | None = None):
        self.config_key = config_key
        if config_key is not None:
            message = f"Configuration '{config_key}': {message}"
        super().__init__(message)


class ProviderError(AgentError):
    """Raised when LLM provider configuration or connection fails."""

    def __init__(self, message: str, provider: str | None = None):
        self.provider = provider
        if provider is not None:
            message = f"Provider '{provider}': {message}"
        super().__init__(message)


class InputValidationError(AFMValidationError):
    """Raised when input data doesn't match the interface signature schema."""

    def __init__(self, message: str, schema_path: str | None = None):
        self.schema_path = schema_path
        super().__init__(message, field="input")


class OutputValidationError(AFMValidationError):
    """Raised when output data doesn't match the interface signature schema."""

    def __init__(self, message: str, schema_path: str | None = None):
        self.schema_path = schema_path
        super().__init__(message, field="output")
