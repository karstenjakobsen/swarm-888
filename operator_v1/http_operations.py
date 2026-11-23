"""Execute and fixture-test HTTP operations declared in a connector manifest."""

import json
import re
from typing import Annotated, Literal
from urllib.parse import quote

import httpx
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import Field, JsonValue, StringConstraints, field_validator, model_validator

from .credentials import CredentialError
from .skill_program import ExecutableProgram
from .tool_types import ToolArguments

FieldName = Annotated[str, StringConstraints(pattern=r"^[A-Za-z_][A-Za-z0-9_-]{0,79}$")]
PathTemplate = Annotated[
    str,
    StringConstraints(
        pattern=r"^/(?:[A-Za-z0-9_-]+|\{[A-Za-z_]\w*\})(?:/(?:[A-Za-z0-9_-]+|\{[A-Za-z_]\w*\}))*$"
    ),
]


class Exchange(ToolArguments):
    method: Literal["GET", "POST", "PUT", "PATCH"]
    path: str
    query: dict[str, str] = Field(default_factory=dict)
    body: dict[str, JsonValue] | None = None
    response: JsonValue


class HttpTest(ToolArguments):
    name: str = Field(min_length=1, max_length=120)
    arguments: dict[str, JsonValue]
    exchanges: list[Exchange] = Field(min_length=1, max_length=50)
    expected: JsonValue


class Pagination(ToolArguments):
    page_parameter: FieldName
    next_field: list[FieldName] = Field(min_length=1)


class Readback(ToolArguments):
    path: PathTemplate
    id_field: FieldName
    result_field: FieldName | None = None


class HttpOperation(ToolArguments):
    description: str = Field(min_length=1, max_length=500)
    scope: str = Field(min_length=1, max_length=120)
    method: Literal["GET", "POST", "PUT", "PATCH"]
    path: PathTemplate
    input_schema: dict[str, JsonValue]
    body_fields: list[FieldName] = Field(default_factory=list)
    query: dict[FieldName, str] = Field(default_factory=dict)
    result_field: FieldName | None = None
    pagination: Pagination | None = None
    verify: Readback | None = None
    tests: list[HttpTest] = Field(min_length=1, max_length=40)

    @field_validator("input_schema")
    @classmethod
    def valid_schema(cls, schema):
        return ExecutableProgram.valid_schema(schema)

    @model_validator(mode="after")
    def check_method(self):
        if self.method == "GET" and (self.body_fields or self.verify):
            raise ValueError("GET operations use a path and query")
        if self.method != "GET" and (not self.verify or not self.body_fields or self.pagination):
            raise ValueError("Write operations require body fields and a verification read")
        return self


def render_path(template: str, values: dict) -> str:
    def segment(match):
        value = values.get(match[1])
        if (
            type(value) not in (str, int)
            or not str(value)
            or any(char in str(value) for char in ("/", "\\", "%", "?", "#"))
            or str(value) in (".", "..")
        ):
            raise CredentialError("Invalid connector path argument")
        return quote(str(value), safe="")

    return re.sub(r"\{(\w+)\}", segment, template)


def selected(payload, field):
    if field is None:
        return payload
    if not isinstance(payload, dict) or field not in payload:
        raise CredentialError("Connector response is missing a declared field")
    return payload[field]


class TokenRejected(CredentialError):
    pass


def execute_http(http: httpx.Client, op: HttpOperation, args: dict, *, dispatch=None, receipt=None):
    if not Draft202012Validator(op.input_schema, format_checker=FormatChecker()).is_valid(args):
        raise CredentialError("Arguments do not match the operation input schema")
    path = render_path(op.path, args)
    body = {key: args[key] for key in op.body_fields if key in args}
    if op.method != "GET" and not body:
        raise CredentialError("Missing connector request body")
    query = dict(op.query)
    records = []

    def request(method, path, **kwargs):
        response = http.request(method, path, **kwargs)
        if response.status_code in (401, 403):
            raise TokenRejected("Provider rejected the credential for this operation")
        response.raise_for_status()
        try:
            return response.json()
        except ValueError:
            raise CredentialError("Connector returned invalid JSON") from None

    for page in range(1, 51):
        if op.pagination:
            query[op.pagination.page_parameter] = str(page)
        if receipt is None:
            if dispatch:
                dispatch.reserve()
            try:
                payload = request(
                    op.method, path, params=query, json=body if op.method != "GET" else None
                )
            except TokenRejected:
                if dispatch:
                    dispatch.rejected()
                raise
            value = selected(payload, op.result_field)
        else:
            value = receipt
        if op.verify:
            identity = selected(value, op.verify.id_field)
            if dispatch and receipt is None:
                dispatch.receipt({op.verify.id_field: identity})
            verify_path = render_path(op.verify.path, {**args, "result_id": identity})
            observed = selected(request("GET", verify_path), op.verify.result_field)
            if (
                not isinstance(observed, dict)
                or observed.get(op.verify.id_field) != identity
                or any(key not in observed or observed[key] != val for key, val in body.items())
            ):
                raise CredentialError("Verification read did not match the requested change")
            return observed
        if not op.pagination:
            return value
        if not isinstance(value, list):
            raise CredentialError("Expected a list in a paginated response")
        records.extend(value)
        next_page = payload
        for key in op.pagination.next_field:
            next_page = next_page.get(key) if isinstance(next_page, dict) else None
        if not next_page:
            return records
    raise CredentialError("Connector pagination limit reached")


def test_operation(op: HttpOperation, endpoint: str) -> list[str]:
    return [run_fixture(op, test, endpoint) for test in op.tests]


def run_fixture(op: HttpOperation, test: HttpTest, endpoint: str) -> str:
    exchanges = iter(test.exchanges)

    def respond(request):
        expected = next(exchanges, None)
        if (
            expected is None
            or request.method != expected.method
            or request.url.path != expected.path
            or dict(request.url.params) != expected.query
            or (json.loads(request.content) if request.content else None) != expected.body
        ):
            raise CredentialError(f"Unexpected HTTP request in fixture {test.name!r}")
        return httpx.Response(200, json=expected.response)

    with httpx.Client(base_url=endpoint, transport=httpx.MockTransport(respond)) as http:
        actual = execute_http(http, op, test.arguments)
    if next(exchanges, None) is not None or actual != test.expected:
        raise CredentialError(f"Fixture {test.name!r} did not match the declared result")
    return test.name
