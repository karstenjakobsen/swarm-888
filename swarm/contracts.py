"""Input contracts shared by the worker's RPC and MCP adapters."""

import inspect
from collections.abc import Callable
from typing import Any, get_type_hints

from pydantic import BaseModel, ConfigDict, create_model


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)


def input_contract(method: Callable[..., Any]) -> type[Contract]:
    hints = get_type_hints(method)
    fields: dict[str, Any] = {
        p.name: (hints[p.name], ... if p.default is p.empty else p.default)
        for p in inspect.signature(method).parameters.values()
    }
    name = getattr(method, "__name__", type(method).__name__)
    return create_model(name + "Input", __base__=Contract, **fields)
