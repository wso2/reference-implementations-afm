# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""JSON Schema validation for AFM interface signatures.

This module provides validation for input/output data against the JSON Schema
definitions in AFM interface signatures.
"""

import json
import re
from typing import Any

import jsonschema
from jsonschema import ValidationError as JsonSchemaValidationError

from .exceptions import InputValidationError, OutputValidationError
from .models import JSONSchema

JSON_BLOCK_PATTERN = re.compile(r"```json\s*([\s\S]*?)\s*```")
GENERIC_BLOCK_PATTERN = re.compile(r"```\s*([\s\S]*?)\s*```")


def json_schema_to_dict(schema: JSONSchema) -> dict[str, Any]:
    """Convert a Pydantic JSONSchema model to a dict for jsonschema library.

    Args:
        schema: The JSONSchema model to convert.

    Returns:
        A dictionary representation suitable for jsonschema validation.
    """
    result: dict[str, Any] = {"type": schema.type}

    if schema.properties is not None:
        result["properties"] = {
            name: json_schema_to_dict(prop) for name, prop in schema.properties.items()
        }

    if schema.required is not None:
        result["required"] = schema.required

    if schema.items is not None:
        result["items"] = json_schema_to_dict(schema.items)

    if schema.description is not None:
        result["description"] = schema.description

    extra_fields = schema.model_dump(
        exclude={"type", "properties", "required", "items", "description"}
    )
    for key, value in extra_fields.items():
        if value is not None:
            result[key] = value

    return result


def validate_input(data: Any, schema: JSONSchema) -> None:
    """Validate input data against an input schema.

    Args:
        data: The input data to validate.
        schema: The JSONSchema to validate against.

    Raises:
        InputValidationError: If the data doesn't match the schema.
    """
    schema_dict = json_schema_to_dict(schema)
    try:
        jsonschema.validate(instance=data, schema=schema_dict)
    except JsonSchemaValidationError as e:
        path = ".".join(str(p) for p in e.absolute_path) if e.absolute_path else None
        raise InputValidationError(e.message, schema_path=path) from e


def validate_output(data: Any, schema: JSONSchema) -> None:
    """Validate output data against an output schema.

    Args:
        data: The output data to validate.
        schema: The JSONSchema to validate against.

    Raises:
        OutputValidationError: If the data doesn't match the schema.
    """
    schema_dict = json_schema_to_dict(schema)
    try:
        jsonschema.validate(instance=data, schema=schema_dict)
    except JsonSchemaValidationError as e:
        path = ".".join(str(p) for p in e.absolute_path) if e.absolute_path else None
        raise OutputValidationError(e.message, schema_path=path) from e


def extract_json_from_response(response: str) -> str:
    """Extract JSON content from an LLM response.

    The LLM may wrap JSON in markdown code blocks. This function extracts
    the JSON content from such blocks, or returns the response as-is if
    no code block is found.

    Args:
        response: The raw LLM response string.

    Returns:
        The extracted JSON string.
    """
    match = JSON_BLOCK_PATTERN.search(response)
    if match:
        return match.group(1).strip()

    match = GENERIC_BLOCK_PATTERN.search(response)
    if match:
        return match.group(1).strip()

    return response.strip()


def coerce_output_to_schema(
    response: str,
    schema: JSONSchema,
) -> Any:
    """Parse and validate an LLM response against an output schema.

    For string schemas, returns the response as-is.
    For other schemas (object, array, number, etc.), attempts to parse
    the response as JSON and validate it.

    Args:
        response: The raw LLM response string.
        schema: The expected output schema.

    Returns:
        The validated output data (string for string schemas, parsed JSON otherwise).

    Raises:
        OutputValidationError: If the response cannot be parsed or doesn't match the schema.
    """
    # String type - return as-is
    if schema.type == "string":
        return response

    # Extract JSON from potential code blocks
    json_str = extract_json_from_response(response)

    # Parse JSON
    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as e:
        raise OutputValidationError(
            f"Failed to parse response as JSON: {e}",
            schema_path=None,
        ) from e

    # Handle non-object schema types
    if schema.type != "object":
        validate_output(data, schema)
        return data

    # Validate against schema
    validate_output(data, schema)
    return data


def build_output_schema_instruction(schema: JSONSchema) -> str:
    """Build an instruction string for the LLM to produce schema-compliant output.

    Args:
        schema: The output schema the LLM should conform to.

    Returns:
        An instruction string to append to the prompt.
    """
    schema_dict = json_schema_to_dict(schema)
    schema_json = json.dumps(schema_dict, indent=2)

    return f"""

The final response MUST conform to the following JSON schema:
{schema_json}

Respond only with the JSON value enclosed between ``` and ```.
Do not include any other text or explanation outside the code block."""
