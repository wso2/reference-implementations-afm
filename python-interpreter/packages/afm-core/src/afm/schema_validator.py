# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

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
            original = getattr(schema, key, None)
            if isinstance(original, JSONSchema):
                result[key] = json_schema_to_dict(original)
            else:
                result[key] = value

    return result


def validate_input(data: Any, schema: JSONSchema) -> None:
    schema_dict = json_schema_to_dict(schema)
    try:
        jsonschema.validate(instance=data, schema=schema_dict)
    except JsonSchemaValidationError as e:
        path = ".".join(str(p) for p in e.absolute_path) if e.absolute_path else None
        raise InputValidationError(e.message, schema_path=path) from e


def validate_output(data: Any, schema: JSONSchema) -> None:
    schema_dict = json_schema_to_dict(schema)
    try:
        jsonschema.validate(instance=data, schema=schema_dict)
    except JsonSchemaValidationError as e:
        path = ".".join(str(p) for p in e.absolute_path) if e.absolute_path else None
        raise OutputValidationError(e.message, schema_path=path) from e


def extract_json_from_response(response: str) -> str:
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
    if schema.type == "string":
        return response

    json_str = extract_json_from_response(response)

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
    schema_dict = json_schema_to_dict(schema)
    schema_json = json.dumps(schema_dict, indent=2)

    return f"""

The final response MUST conform to the following JSON schema:
{schema_json}

Respond only with the JSON value enclosed between ``` and ```.
Do not include any other text or explanation outside the code block."""
