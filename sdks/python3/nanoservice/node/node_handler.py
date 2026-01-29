from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any, Dict, Tuple

from nanoservice.types.context import Context


class NodeHandler(ABC):
    """Base class that all Blok nodes must inherit from.

    Subclasses must implement the ``execute`` method which receives the
    workflow context and node-specific configuration, and returns a
    data value (any JSON-serializable value).

    Example::

        class GreetNode(NodeHandler):
            def execute(self, ctx, config):
                name = ctx.request.body_str("name") or "World"
                prefix = config.get("prefix", "Hello")
                return {"message": f"{prefix}, {name}!"}
    """

    @abstractmethod
    def execute(self, ctx: Context, config: Dict[str, Any]) -> Any:
        """Execute the node logic.

        Args:
            ctx: The workflow execution context.
            config: Node-specific configuration.

        Returns:
            JSON-serializable result data.
        """
        raise NotImplementedError
