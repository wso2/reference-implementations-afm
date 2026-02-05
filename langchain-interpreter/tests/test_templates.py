# Copyright (c) 2025
# Licensed under the Apache License, Version 2.0

"""Tests for the template compilation and evaluation module."""

import pytest

from langchain_interpreter import (
    CompiledTemplate,
    HeaderVariable,
    JSONAccessError,
    LiteralSegment,
    PayloadVariable,
    TemplateCompilationError,
    access_json_field,
    compile_template,
    evaluate_template,
)


class TestCompileTemplate:
    """Tests for the compile_template function."""

    def test_literal_only(self) -> None:
        """Test compiling a template with only literal text."""
        template = "This is a literal string"
        compiled = compile_template(template)

        assert len(compiled.segments) == 1
        seg = compiled.segments[0]
        assert isinstance(seg, LiteralSegment)
        assert seg.text == "This is a literal string"

    def test_payload_variable(self) -> None:
        """Test compiling a template with a payload variable."""
        template = "Value: ${http:payload.field}"
        compiled = compile_template(template)

        assert len(compiled.segments) == 2
        assert isinstance(compiled.segments[0], LiteralSegment)
        assert compiled.segments[0].text == "Value: "
        assert isinstance(compiled.segments[1], PayloadVariable)
        assert compiled.segments[1].path == "field"

    def test_header_variable(self) -> None:
        """Test compiling a template with a header variable."""
        template = "Auth: ${http:header.Authorization}"
        compiled = compile_template(template)

        assert len(compiled.segments) == 2
        assert isinstance(compiled.segments[0], LiteralSegment)
        assert compiled.segments[0].text == "Auth: "
        assert isinstance(compiled.segments[1], HeaderVariable)
        assert compiled.segments[1].name == "Authorization"

    def test_multiple_variables(self) -> None:
        """Test compiling a template with multiple variables."""
        template = "User ${http:payload.name} from ${http:header.Origin}"
        compiled = compile_template(template)

        assert len(compiled.segments) == 4
        assert isinstance(compiled.segments[0], LiteralSegment)
        assert compiled.segments[0].text == "User "
        assert isinstance(compiled.segments[1], PayloadVariable)
        assert compiled.segments[1].path == "name"
        assert isinstance(compiled.segments[2], LiteralSegment)
        assert compiled.segments[2].text == " from "
        assert isinstance(compiled.segments[3], HeaderVariable)
        assert compiled.segments[3].name == "Origin"

    def test_non_http_variable_preserved(self) -> None:
        """Test that non-http variables are preserved as literals."""
        template = "Static: ${env:VAR}"
        compiled = compile_template(template)

        assert len(compiled.segments) == 2
        assert isinstance(compiled.segments[0], LiteralSegment)
        assert compiled.segments[0].text == "Static: "
        assert isinstance(compiled.segments[1], LiteralSegment)
        assert compiled.segments[1].text == "${env:VAR}"

    def test_entire_payload(self) -> None:
        """Test compiling with entire payload reference."""
        template = "Payload: ${http:payload}"
        compiled = compile_template(template)

        assert len(compiled.segments) == 2
        assert isinstance(compiled.segments[1], PayloadVariable)
        assert compiled.segments[1].path == ""

    def test_consecutive_variables(self) -> None:
        """Test consecutive variables without separator."""
        template = "${http:payload.a}${http:payload.b}"
        compiled = compile_template(template)

        assert len(compiled.segments) == 2
        assert isinstance(compiled.segments[0], PayloadVariable)
        assert compiled.segments[0].path == "a"
        assert isinstance(compiled.segments[1], PayloadVariable)
        assert compiled.segments[1].path == "b"

    def test_empty_template(self) -> None:
        """Test compiling an empty template."""
        compiled = compile_template("")
        assert len(compiled.segments) == 0

    def test_only_variable(self) -> None:
        """Test template that is only a variable."""
        template = "${http:payload.data}"
        compiled = compile_template(template)

        assert len(compiled.segments) == 1
        assert isinstance(compiled.segments[0], PayloadVariable)
        assert compiled.segments[0].path == "data"

    def test_unknown_prefix_error(self) -> None:
        """Test that unknown http prefix raises error."""
        template = "Data: ${http:unknown.field}"
        with pytest.raises(TemplateCompilationError) as exc_info:
            compile_template(template)
        assert "Unknown http variable prefix: unknown" in str(exc_info.value)

    def test_invalid_format_error(self) -> None:
        """Test that invalid format raises error."""
        template = "Value: ${http:header}"
        with pytest.raises(TemplateCompilationError) as exc_info:
            compile_template(template)
        # "http:header" without a dot is treated as unknown prefix
        assert "Unknown http variable prefix: header" in str(exc_info.value)

    def test_incomplete_payload_access_error(self) -> None:
        """Test that incomplete payload access raises error."""
        template = "Payload: ${http:payload.}"
        with pytest.raises(TemplateCompilationError) as exc_info:
            compile_template(template)
        assert "Invalid http variable format" in str(exc_info.value)

    def test_missing_close_brace(self) -> None:
        """Test handling missing closing brace."""
        template = "Value: ${http:payload.field"
        compiled = compile_template(template)

        # Should treat entire string as one literal segment when closing brace is missing
        assert len(compiled.segments) == 1
        assert isinstance(compiled.segments[0], LiteralSegment)
        assert compiled.segments[0].text == "Value: ${http:payload.field"


class TestEvaluateTemplate:
    """Tests for the evaluate_template function."""

    def test_evaluate_literal(self) -> None:
        """Test evaluating a literal-only template."""
        compiled = CompiledTemplate(segments=(LiteralSegment(text="Hello, World!"),))
        result = evaluate_template(compiled, {}, None)
        assert result == "Hello, World!"

    def test_evaluate_payload_field(self) -> None:
        """Test evaluating a payload field."""
        compiled = CompiledTemplate(
            segments=(
                LiteralSegment(text="Name: "),
                PayloadVariable(path="name"),
            )
        )
        payload = {"name": "John Doe", "age": 30}
        result = evaluate_template(compiled, payload, None)
        assert result == "Name: John Doe"

    def test_evaluate_entire_payload(self) -> None:
        """Test evaluating entire payload reference."""
        compiled = CompiledTemplate(segments=(PayloadVariable(path=""),))
        payload = {"message": "Hello"}
        result = evaluate_template(compiled, payload, None)
        assert '"message"' in result
        assert '"Hello"' in result

    def test_evaluate_nested_payload(self) -> None:
        """Test evaluating nested payload field."""
        compiled = CompiledTemplate(segments=(PayloadVariable(path="user.name"),))
        payload = {"user": {"name": "Alice", "id": 123}}
        result = evaluate_template(compiled, payload, None)
        assert result == "Alice"

    def test_evaluate_header(self) -> None:
        """Test evaluating header variable."""
        compiled = CompiledTemplate(
            segments=(
                LiteralSegment(text="Auth: "),
                HeaderVariable(name="Authorization"),
            )
        )
        headers = {
            "Authorization": "Bearer token123",
            "Content-Type": "application/json",
        }
        result = evaluate_template(compiled, {}, headers)
        assert result == "Auth: Bearer token123"

    def test_evaluate_header_case_insensitive(self) -> None:
        """Test case-insensitive header lookup."""
        compiled = CompiledTemplate(segments=(HeaderVariable(name="authorization"),))
        headers = {"Authorization": "Bearer token"}
        result = evaluate_template(compiled, {}, headers)
        assert result == "Bearer token"

    def test_evaluate_header_array_value(self) -> None:
        """Test evaluating header with array value."""
        compiled = CompiledTemplate(segments=(HeaderVariable(name="Accept"),))
        headers = {"Accept": ["application/json", "text/html"]}
        result = evaluate_template(compiled, {}, headers)
        assert result == "application/json, text/html"

    def test_evaluate_missing_header(self) -> None:
        """Test evaluating missing header returns empty string."""
        compiled = CompiledTemplate(segments=(HeaderVariable(name="NonExistent"),))
        headers = {"Authorization": "Bearer token"}
        result = evaluate_template(compiled, {}, headers)
        assert result == ""

    def test_evaluate_no_headers(self) -> None:
        """Test evaluating with no headers provided."""
        compiled = CompiledTemplate(segments=(HeaderVariable(name="Authorization"),))
        result = evaluate_template(compiled, {}, None)
        assert result == ""

    def test_evaluate_missing_payload_field(self) -> None:
        """Test evaluating missing payload field returns empty string."""
        compiled = CompiledTemplate(
            segments=(PayloadVariable(path="nonexistent.field"),)
        )
        payload = {"name": "test"}
        result = evaluate_template(compiled, payload, None)
        assert result == ""

    def test_evaluate_non_string_payload(self) -> None:
        """Test evaluating non-string payload value."""
        compiled = CompiledTemplate(segments=(PayloadVariable(path="count"),))
        payload = {"count": 42}
        result = evaluate_template(compiled, payload, None)
        assert result == "42"

    def test_evaluate_object_payload(self) -> None:
        """Test evaluating object payload value."""
        compiled = CompiledTemplate(segments=(PayloadVariable(path="user"),))
        payload = {"user": {"name": "Alice", "age": 30}}
        result = evaluate_template(compiled, payload, None)
        assert '"name"' in result
        assert '"Alice"' in result

    def test_evaluate_complex_template(self) -> None:
        """Test evaluating a complex mixed template."""
        compiled = CompiledTemplate(
            segments=(
                LiteralSegment(text="Request from "),
                HeaderVariable(name="User-Agent"),
                LiteralSegment(text=" with data: "),
                PayloadVariable(path="message"),
                LiteralSegment(text=" (count: "),
                PayloadVariable(path="count"),
                LiteralSegment(text=")"),
            )
        )
        payload = {"message": "Hello", "count": 5}
        headers = {"User-Agent": "TestClient/1.0"}
        result = evaluate_template(compiled, payload, headers)
        assert result == "Request from TestClient/1.0 with data: Hello (count: 5)"


class TestAccessJsonField:
    """Tests for the access_json_field function."""

    def test_dot_notation_simple(self) -> None:
        """Test simple dot notation access."""
        payload = {"user": {"name": "Bob"}}
        result = access_json_field(payload, "user.name")
        assert result == "Bob"

    def test_dot_notation_nested(self) -> None:
        """Test nested dot notation access."""
        payload = {"user": {"address": {"city": "NYC"}}}
        result = access_json_field(payload, "user.address.city")
        assert result == "NYC"

    def test_bracket_notation_quoted(self) -> None:
        """Test bracket notation with quoted field name."""
        payload = {"field.with.dots": "value"}
        result = access_json_field(payload, "['field.with.dots']")
        assert result == "value"

    def test_bracket_notation_double_quotes(self) -> None:
        """Test bracket notation with double quotes."""
        payload = {"field.name": "value"}
        result = access_json_field(payload, '["field.name"]')
        assert result == "value"

    def test_array_index(self) -> None:
        """Test array index access."""
        payload = {"items": ["first", "second", "third"]}
        result = access_json_field(payload, "items[1]")
        assert result == "second"

    def test_mixed_access(self) -> None:
        """Test mixed dot and array access."""
        payload = {"data": {"items": ["a", "b", "c"]}}
        result = access_json_field(payload, "data.items[2]")
        assert result == "c"

    def test_bracket_with_array(self) -> None:
        """Test bracket notation combined with array access."""
        payload = {
            "users.list": [
                {"full.name": "Alice"},
                {"full.name": "Bob"},
                {"full.name": "Charlie"},
            ]
        }
        result = access_json_field(payload, "['users.list'][1]['full.name']")
        assert result == "Bob"

    def test_array_of_objects(self) -> None:
        """Test accessing array of objects."""
        payload = [
            {"items": [1, 2, 3]},
            {"items": [4, 5, 6]},
            {"items": [7, 8, 9]},
        ]
        result = access_json_field(payload, "[1].items[2]")
        assert result == 6

    def test_empty_path(self) -> None:
        """Test empty path returns the payload itself."""
        payload = {"data": "value"}
        result = access_json_field(payload, "")
        assert result == payload

    def test_invalid_field_path(self) -> None:
        """Test accessing non-existent field raises error."""
        payload = {"user": {"name": "Alice"}}
        with pytest.raises(JSONAccessError) as exc_info:
            access_json_field(payload, "user.nonexistent")
        assert "not found" in str(exc_info.value)

    def test_array_index_out_of_bounds(self) -> None:
        """Test array index out of bounds raises error."""
        payload = {"items": ["a", "b"]}
        with pytest.raises(JSONAccessError) as exc_info:
            access_json_field(payload, "items[5]")
        assert "out of bounds" in str(exc_info.value)

    def test_negative_array_index(self) -> None:
        """Test negative array index raises error."""
        payload = {"items": [1, 2, 3]}
        with pytest.raises(JSONAccessError) as exc_info:
            access_json_field(payload, "items[-1]")
        assert "out of bounds" in str(exc_info.value)

    def test_invalid_array_index(self) -> None:
        """Test invalid array index raises error."""
        payload = {"items": ["a", "b"]}
        with pytest.raises(JSONAccessError) as exc_info:
            access_json_field(payload, "items[abc]")
        assert "Invalid array index" in str(exc_info.value)

    def test_access_field_on_non_object(self) -> None:
        """Test accessing field on non-object raises error."""
        payload = "string value"
        with pytest.raises(JSONAccessError) as exc_info:
            access_json_field(payload, "['field']")
        assert "non-object" in str(exc_info.value)

    def test_access_index_on_non_array(self) -> None:
        """Test accessing index on non-array raises error."""
        payload = {"data": "not an array"}
        with pytest.raises(JSONAccessError) as exc_info:
            access_json_field(payload, "data[0]")
        assert "non-array" in str(exc_info.value)

    def test_missing_close_bracket(self) -> None:
        """Test missing close bracket raises error."""
        payload = {"data": "value"}
        with pytest.raises(JSONAccessError) as exc_info:
            access_json_field(payload, "[field")
        assert "Invalid bracket notation" in str(exc_info.value)

    def test_field_access_on_array(self) -> None:
        """Test accessing field on array raises error."""
        payload = ["array", "items"]
        with pytest.raises(JSONAccessError) as exc_info:
            access_json_field(payload, "field")
        assert "non-object" in str(exc_info.value)

    def test_bracket_continuation_with_dot(self) -> None:
        """Test bracket notation followed by dot notation."""
        payload = {
            "data": {
                "items": [
                    {"name": "first"},
                    {"name": "second"},
                ]
            }
        }
        result = access_json_field(payload, "['data'].items[1].name")
        assert result == "second"
