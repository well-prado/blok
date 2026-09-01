"""Language-neutral capability manifest contract (ADR 0003)."""

from __future__ import annotations

from typing import Dict, List, NotRequired, TypedDict


class CapabilityResourceBounds(TypedDict, total=False):
    maxDurationMs: int
    maxMemoryBytes: int
    maxInputBytes: int
    maxOutputBytes: int
    maxConcurrency: int


class CapabilityManifest(TypedDict):
    version: str
    classification: str
    effects: List[str]
    capabilities: List[str]
    secrets: List[str]
    determinism: str
    idempotency: str
    maturity: str
    resources: NotRequired[CapabilityResourceBounds]
    runtimes: NotRequired[List[str]]
    triggers: NotRequired[List[str]]


def validate_capability_manifest(value: CapabilityManifest) -> CapabilityManifest:
    """Reject obviously unsafe/unsupported metadata before advertising it."""
    required = (
        "version", "classification", "effects", "capabilities", "secrets",
        "determinism", "idempotency", "maturity",
    )
    missing = [key for key in required if key not in value]
    if missing:
        raise ValueError(f"capability manifest missing: {', '.join(missing)}")
    if value["version"] != "1":
        raise ValueError("capability manifest version must be 1")
    if any("=" in secret for secret in value["secrets"]):
        raise ValueError("capability manifest secrets must be reference names, never values")
    return value
