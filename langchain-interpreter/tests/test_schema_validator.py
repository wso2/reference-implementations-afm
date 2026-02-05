# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Tests for schema validation functionality."""

import pytest

from langchain_interpreter.exceptions import InputValidationError, OutputValidationError
from langchain_interpreter.models import JSONSchema
from langchain_interpreter.schema_validator import (
    build_output_schema_instruction,
    coerce_output_to_schema,
    extract_json_from_response,
    json_schema_to_dict,
    validate_input,
    validate_output,
)


# =============================================================================
# json_schema_to_dict Tests
# =============================================================================


class TestJsonSchemaToDict:
    """Tests for json_schema_to_dict function."""

    def test_simple_string_schema(self) -> None:
        """Test converting a simple string schema."""
        schema = JSONSchema(type="string")
        result = json_schema_to_dict(schema)
        assert result == {"type": "string"}

    def test_simple_number_schema(self) -> None:
        """Test converting a simple number schema."""
        schema = JSONSchema(type="number")
        result = json_schema_to_dict(schema)
        assert result == {"type": "number"}

    def test_object_schema_with_properties(self) -> None:
        """Test converting an object schema with properties."""
        schema = JSONSchema(
            type="object",
            properties={
                "name": JSONSchema(type="string"),
                "age": JSONSchema(type="integer"),
            },
            required=["name"],
        )
        result = json_schema_to_dict(schema)
        assert result == {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "integer"},
            },
            "required": ["name"],
        }

    def test_array_schema_with_items(self) -> None:
        """Test converting an array schema with items."""
        schema = JSONSchema(
            type="array",
            items=JSONSchema(type="string"),
        )
        result = json_schema_to_dict(schema)
        assert result == {
            "type": "array",
            "items": {"type": "string"},
        }

    def test_schema_with_description(self) -> None:
        """Test converting a schema with description."""
        schema = JSONSchema(type="string", description="A user's name")
        result = json_schema_to_dict(schema)
        assert result == {"type": "string", "description": "A user's name"}

    def test_nested_object_schema(self) -> None:
        """Test converting a nested object schema."""
        schema = JSONSchema(
            type="object",
            properties={
                "user": JSONSchema(
                    type="object",
                    properties={
                        "name": JSONSchema(type="string"),
                        "email": JSONSchema(type="string"),
                    },
                    required=["name"],
                ),
            },
        )
        result = json_schema_to_dict(schema)
        assert result["properties"]["user"]["type"] == "object"
        assert result["properties"]["user"]["properties"]["name"] == {"type": "string"}
        assert result["properties"]["user"]["required"] == ["name"]


# =============================================================================
# validate_input Tests
# =============================================================================


class TestValidateInput:
    """Tests for validate_input function."""

    def test_valid_string_input(self) -> None:
        """Test validating a valid string input."""
        schema = JSONSchema(type="string")
        validate_input("hello", schema)  # Should not raise

    def test_invalid_string_input(self) -> None:
        """Test validating an invalid string input."""
        schema = JSONSchema(type="string")
        with pytest.raises(InputValidationError):
            validate_input(123, schema)

    def test_valid_object_input(self) -> None:
        """Test validating a valid object input."""
        schema = JSONSchema(
            type="object",
            properties={"name": JSONSchema(type="string")},
            required=["name"],
        )
        validate_input({"name": "Alice"}, schema)  # Should not raise

    def test_missing_required_field(self) -> None:
        """Test validating an object with missing required field."""
        schema = JSONSchema(
            type="object",
            properties={"name": JSONSchema(type="string")},
            required=["name"],
        )
        with pytest.raises(InputValidationError) as exc_info:
            validate_input({}, schema)
        assert "'name' is a required property" in str(exc_info.value)

    def test_valid_array_input(self) -> None:
        """Test validating a valid array input."""
        schema = JSONSchema(
            type="array",
            items=JSONSchema(type="number"),
        )
        validate_input([1, 2, 3], schema)  # Should not raise

    def test_invalid_array_item(self) -> None:
        """Test validating an array with invalid item type."""
        schema = JSONSchema(
            type="array",
            items=JSONSchema(type="number"),
        )
        with pytest.raises(InputValidationError):
            validate_input([1, "two", 3], schema)

    def test_error_includes_path(self) -> None:
        """Test that validation error includes the path to the invalid field."""
        schema = JSONSchema(
            type="object",
            properties={
                "user": JSONSchema(
                    type="object",
                    properties={"age": JSONSchema(type="integer")},
                ),
            },
        )
        with pytest.raises(InputValidationError) as exc_info:
            validate_input({"user": {"age": "not a number"}}, schema)
        assert exc_info.value.schema_path is not None


# =============================================================================
# validate_output Tests
# =============================================================================


class TestValidateOutput:
    """Tests for validate_output function."""

    def test_valid_string_output(self) -> None:
        """Test validating a valid string output."""
        schema = JSONSchema(type="string")
        validate_output("hello", schema)  # Should not raise

    def test_invalid_string_output(self) -> None:
        """Test validating an invalid string output."""
        schema = JSONSchema(type="string")
        with pytest.raises(OutputValidationError):
            validate_output(123, schema)

    def test_valid_object_output(self) -> None:
        """Test validating a valid object output."""
        schema = JSONSchema(
            type="object",
            properties={"result": JSONSchema(type="string")},
            required=["result"],
        )
        validate_output({"result": "success"}, schema)  # Should not raise

    def test_invalid_object_output(self) -> None:
        """Test validating an invalid object output."""
        schema = JSONSchema(
            type="object",
            properties={"result": JSONSchema(type="string")},
            required=["result"],
        )
        with pytest.raises(OutputValidationError):
            validate_output({"result": 123}, schema)


# =============================================================================
# extract_json_from_response Tests
# =============================================================================


class TestExtractJsonFromResponse:
    """Tests for extract_json_from_response function."""

    def test_plain_json(self) -> None:
        """Test extracting plain JSON without code block."""
        response = '{"key": "value"}'
        result = extract_json_from_response(response)
        assert result == '{"key": "value"}'

    def test_json_code_block(self) -> None:
        """Test extracting JSON from ```json code block."""
        response = """Here is the result:
```json
{"key": "value"}
```
"""
        result = extract_json_from_response(response)
        assert result == '{"key": "value"}'

    def test_generic_code_block(self) -> None:
        """Test extracting JSON from generic ``` code block."""
        response = """Here is the result:
```
{"key": "value"}
```
"""
        result = extract_json_from_response(response)
        assert result == '{"key": "value"}'

    def test_json_code_block_with_extra_whitespace(self) -> None:
        """Test extracting JSON with whitespace in code block."""
        response = """```json

  {"key": "value"}

```"""
        result = extract_json_from_response(response)
        assert result == '{"key": "value"}'

    def test_multiline_json(self) -> None:
        """Test extracting multiline JSON from code block."""
        response = """```json
{
  "name": "Alice",
  "age": 30
}
```"""
        result = extract_json_from_response(response)
        assert '"name": "Alice"' in result
        assert '"age": 30' in result

    def test_multiple_code_blocks_returns_first(self) -> None:
        """Test that first code block is returned when multiple exist."""
        response = """```json
{"first": true}
```
Some text
```json
{"second": true}
```"""
        result = extract_json_from_response(response)
        assert result == '{"first": true}'


# =============================================================================
# coerce_output_to_schema Tests
# =============================================================================


class TestCoerceOutputToSchema:
    """Tests for coerce_output_to_schema function."""

    def test_string_schema_returns_as_is(self) -> None:
        """Test that string schema returns response as-is."""
        schema = JSONSchema(type="string")
        result = coerce_output_to_schema("Hello, world!", schema)
        assert result == "Hello, world!"

    def test_object_schema_parses_json(self) -> None:
        """Test that object schema parses JSON response."""
        schema = JSONSchema(
            type="object",
            properties={"name": JSONSchema(type="string")},
        )
        response = '{"name": "Alice"}'
        result = coerce_output_to_schema(response, schema)
        assert result == {"name": "Alice"}

    def test_object_schema_extracts_from_code_block(self) -> None:
        """Test that object schema extracts JSON from code block."""
        schema = JSONSchema(
            type="object",
            properties={"count": JSONSchema(type="integer")},
        )
        response = """Here's the count:
```json
{"count": 42}
```
"""
        result = coerce_output_to_schema(response, schema)
        assert result == {"count": 42}

    def test_array_schema_parses_json(self) -> None:
        """Test that array schema parses JSON response."""
        schema = JSONSchema(
            type="array",
            items=JSONSchema(type="string"),
        )
        response = '["one", "two", "three"]'
        result = coerce_output_to_schema(response, schema)
        assert result == ["one", "two", "three"]

    def test_number_schema_parses_json(self) -> None:
        """Test that number schema parses JSON response."""
        schema = JSONSchema(type="number")
        response = "42.5"
        result = coerce_output_to_schema(response, schema)
        assert result == 42.5

    def test_invalid_json_raises_error(self) -> None:
        """Test that invalid JSON raises OutputValidationError."""
        schema = JSONSchema(type="object")
        response = "not valid json"
        with pytest.raises(OutputValidationError) as exc_info:
            coerce_output_to_schema(response, schema)
        assert "Failed to parse response as JSON" in str(exc_info.value)

    def test_schema_mismatch_raises_error(self) -> None:
        """Test that schema mismatch raises OutputValidationError."""
        schema = JSONSchema(
            type="object",
            properties={"name": JSONSchema(type="string")},
            required=["name"],
        )
        response = '{"wrong_field": "value"}'
        with pytest.raises(OutputValidationError):
            coerce_output_to_schema(response, schema)


# =============================================================================
# build_output_schema_instruction Tests
# =============================================================================


class TestBuildOutputSchemaInstruction:
    """Tests for build_output_schema_instruction function."""

    def test_builds_instruction_with_schema(self) -> None:
        """Test that instruction includes the schema."""
        schema = JSONSchema(
            type="object",
            properties={"result": JSONSchema(type="string")},
        )
        instruction = build_output_schema_instruction(schema)
        assert "JSON schema" in instruction
        assert '"type": "object"' in instruction
        assert '"result"' in instruction
        assert "```" in instruction

    def test_instruction_for_array_schema(self) -> None:
        """Test instruction for array schema."""
        schema = JSONSchema(
            type="array",
            items=JSONSchema(type="number"),
        )
        instruction = build_output_schema_instruction(schema)
        assert '"type": "array"' in instruction
        assert '"items"' in instruction
