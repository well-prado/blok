from __future__ import annotations
from typing import Any, Dict, Optional
from blok.types.context import Context


class NodeConfig:
    """Represents node-specific configuration from the runner."""

    __slots__ = ("name", "type", "config")

    def __init__(
        self,
        name: str = "",
        type: str = "",
        config: Optional[Dict[str, Any]] = None,
    ):
        self.name = name
        self.type = type
        self.config = config or {}

    def get_config_str(self, key: str, default: str = "") -> str:
        """Retrieve a string config value with a default."""
        val = self.config.get(key)
        if val is None:
            return default
        return str(val)

    def get_config_int(self, key: str, default: int = 0) -> int:
        """Retrieve an integer config value with a default."""
        val = self.config.get(key)
        if val is None:
            return default
        try:
            return int(val)
        except (ValueError, TypeError):
            return default

    def get_config_bool(self, key: str, default: bool = False) -> bool:
        """Retrieve a boolean config value with a default."""
        val = self.config.get(key)
        if val is None:
            return default
        if isinstance(val, bool):
            return val
        return default

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> NodeConfig:
        return cls(
            name=data.get("name", ""),
            type=data.get("type", ""),
            config=data.get("config", {}),
        )


class ExecutionRequest:
    """The request received from the Blok runner."""

    __slots__ = ("node", "context")

    def __init__(
        self,
        node: Optional[NodeConfig] = None,
        context: Optional[Context] = None,
    ):
        self.node = node or NodeConfig()
        self.context = context or Context()

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> ExecutionRequest:
        return cls(
            node=NodeConfig.from_dict(data.get("node", {})),
            context=Context.from_dict(data.get("context", {})),
        )
