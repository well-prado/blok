from __future__ import annotations
from typing import Any, Dict

from blok.node.node_handler import NodeHandler
from blok.types.context import Context
from blok.errors.node_error import NodeError


class TransformDataNode(NodeHandler):
    """Transforms JSON data based on field mappings.

    Config:
        mappings (dict, optional): Map of target field -> source field path (dot-notation)
        include_only (list, optional): Only include these fields in output
        exclude (list, optional): Exclude these fields from output
        defaults (dict, optional): Default values for missing fields

    Input: Request body (must be a JSON object)
    Output: Transformed JSON object
    """

    def execute(self, ctx: Context, config: Dict[str, Any]) -> Any:
        body = ctx.request.body_map()
        if body is None:
            raise NodeError.validation("request body must be a JSON object")

        result: Dict[str, Any] = {}

        # Apply field mappings if configured
        mappings = config.get("mappings")
        if isinstance(mappings, dict):
            for target_field, source_path in mappings.items():
                if not isinstance(source_path, str):
                    continue
                value = _get_nested_value(body, source_path)
                if value is not None:
                    result[target_field] = value
        else:
            # No mappings -- copy all fields
            result = dict(body)

        # Apply include_only filter
        include_only = config.get("include_only")
        if isinstance(include_only, list) and include_only:
            result = {k: v for k, v in result.items() if k in include_only}

        # Apply exclude filter
        exclude = config.get("exclude")
        if isinstance(exclude, list):
            for field in exclude:
                result.pop(field, None)

        # Apply defaults for missing fields
        defaults = config.get("defaults")
        if isinstance(defaults, dict):
            for k, v in defaults.items():
                if k not in result:
                    result[k] = v

        ctx.set_var("transformed_data", result)
        return result


def _get_nested_value(data: Dict[str, Any], path: str) -> Any:
    """Traverse dot-notation path into nested dicts."""
    current: Any = data
    for part in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current
