# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""LangChain AFM Interpreter.

A Python implementation of the AFM (Agent-Flavored Markdown) specification v0.3.0.
"""

from .agent import Agent
from .exceptions import (
    AFMError,
    AFMParseError,
    AFMValidationError,
    AgentConfigError,
    AgentError,
    InputValidationError,
    JSONAccessError,
    OutputValidationError,
    ProviderError,
    TemplateCompilationError,
    TemplateError,
    TemplateEvaluationError,
    VariableResolutionError,
)
from .models import (
    AFMRecord,
    AgentMetadata,
    ClientAuthentication,
    CompiledTemplate,
    ConsoleChatInterface,
    Exposure,
    HeaderVariable,
    HTTPExposure,
    Interface,
    InterfaceType,
    JSONSchema,
    LiteralSegment,
    MCPServer,
    Model,
    PayloadVariable,
    Provider,
    Signature,
    Subscription,
    TemplateSegment,
    ToolFilter,
    Tools,
    Transport,
    TransportType,
    WebChatInterface,
    WebhookInterface,
    get_filtered_tools,
)
from .parser import parse_afm, parse_afm_file, validate_and_extract_interfaces
from .providers import (
    create_model_provider,
    get_supported_providers,
)
from .schema_validator import (
    build_output_schema_instruction,
    coerce_output_to_schema,
    extract_json_from_response,
    json_schema_to_dict,
    validate_input,
    validate_output,
)
from .templates import access_json_field, compile_template, evaluate_template
from .variables import (
    contains_http_variable,
    resolve_variables,
    validate_http_variables,
)

__version__ = "0.1.0"

__all__ = [
    # Version
    "__version__",
    # Parser Functions
    "parse_afm",
    "parse_afm_file",
    "validate_and_extract_interfaces",
    # Variables
    "resolve_variables",
    "contains_http_variable",
    "validate_http_variables",
    # Templates
    "compile_template",
    "evaluate_template",
    "access_json_field",
    # Models
    "AFMRecord",
    "AgentMetadata",
    "Provider",
    "Model",
    "ClientAuthentication",
    "Transport",
    "TransportType",
    "ToolFilter",
    "MCPServer",
    "Tools",
    "JSONSchema",
    "Signature",
    "HTTPExposure",
    "Exposure",
    "Subscription",
    "InterfaceType",
    "ConsoleChatInterface",
    "WebChatInterface",
    "WebhookInterface",
    "Interface",
    "CompiledTemplate",
    "LiteralSegment",
    "PayloadVariable",
    "HeaderVariable",
    "TemplateSegment",
    "get_filtered_tools",
    # Exceptions
    "AFMError",
    "AFMParseError",
    "AFMValidationError",
    "VariableResolutionError",
    "TemplateError",
    "TemplateCompilationError",
    "TemplateEvaluationError",
    "JSONAccessError",
    # Agent Class
    "Agent",
    # Provider Factory
    "create_model_provider",
    "get_supported_providers",
    # Schema Validation
    "validate_input",
    "validate_output",
    "coerce_output_to_schema",
    "extract_json_from_response",
    "json_schema_to_dict",
    "build_output_schema_instruction",
    "AgentError",
    "AgentConfigError",
    "ProviderError",
    "InputValidationError",
    "OutputValidationError",
]


def main() -> None:
    """CLI entry point."""
    print("LangChain AFM Interpreter v" + __version__)
