"""What every HTTP adapter does the same way: check the signature, call the workflow, and turn what
happened into a status and a JSON body. An adapter only translates its own request and response to and from this.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from .kernel import BlokError, Log, console_log
from .workflow import HttpBinding, Signature

_STATUS = {"invalid_input": 400, "not_implemented": 501}
_UNPLANNED = "The server could not complete the request."


async def answer(
    binding: HttpBinding,
    call: Callable[..., Awaitable[Any]],
    request: Mapping[str, Any],
    *,
    raw: str | bytes | None = None,
    log: Log | None = None,
    now: Callable[[], float] | None = None,
) -> tuple[int, Any]:
    """Runs the workflow behind one route and says what to answer with: a status and a body. It does not raise.

    `request` holds `method`, `body`, `query`, `params` and `headers`, with header names in lower case.
    `raw` is the body exactly as it arrived, which a signed route needs. `now` is the time in milliseconds.
    """
    log = log or console_log
    if binding.signature:
        if raw is None:
            log.error(
                f"{binding.unit.id} checks a signature, and the body as it arrived was gone before Blok saw the request. "
                "Mount Blok before anything that parses the body."
            )
            return 500, {"error": "unexpected", "message": _UNPLANNED}
        at = now() if now else time.time() * 1000
        if not signed(binding.signature, raw, request.get("headers") or {}, at):
            return 401, {"error": "invalid_signature", "message": "The signature does not match."}
    try:
        return binding.success or 200, await call(binding.unit, dict(request))
    except Exception as err:
        error = err if isinstance(err, BlokError) else BlokError("unexpected", str(err), binding.unit.id)
        status = (binding.status or {}).get(error.code, _STATUS.get(error.code))
        if status is not None:
            return status, {"error": error.code, "message": error.message, "node": error.node}
        # A failure nobody planned for. What went wrong is for the log, not for whoever sent the request.
        log.error(f'{binding.unit.id} failed with "{error.code}" at {error.node}: {error.message}', error.details)
        return 500, {"error": error.code, "message": _UNPLANNED}


# ---- signatures --------------------------------------------------------------------------

#: How far a signed request's clock may be from ours. Older than this, it may be a recording played back.
_TOLERANCE_SECONDS = 5 * 60
_HEX = re.compile(r"[0-9a-fA-F]*")
_BASE64 = re.compile(r"[A-Za-z0-9+/]*")
_DIGITS = re.compile(r"[0-9]+")


def _from_hex(text: str) -> bytes | None:
    if len(text) % 2 != 0 or not _HEX.fullmatch(text):
        return None
    return bytes.fromhex(text)


def _from_base64(text: str) -> bytes | None:
    """Base64 read the forgiving way browsers read it: spaces are skipped and the "=" at the end may be left out."""
    packed = re.sub(r"[\t\n\f\r ]", "", text)
    if len(packed) % 4 == 0:
        packed = re.sub(r"={1,2}$", "", packed)
    if len(packed) % 4 == 1 or not _BASE64.fullmatch(packed):
        return None
    try:
        return base64.b64decode(packed + "=" * (-len(packed) % 4))
    except (binascii.Error, ValueError):
        return None


def _same(expected: bytes, given: bytes | None) -> bool:
    """Compares in the same time whatever the bytes are, so the answer's timing says nothing about the signature."""
    return given is not None and hmac.compare_digest(expected, given)


def _hmac(secret: bytes, before: str, body: bytes) -> bytes:
    return hmac.new(secret, before.encode() + body, hashlib.sha256).digest()


def _recent(seconds: str | None, now: float) -> bool:
    return (
        seconds is not None
        and bool(_DIGITS.fullmatch(seconds))
        and abs(now / 1000 - int(seconds)) <= _TOLERANCE_SECONDS
    )


def signed(signature: Signature, raw: str | bytes, headers: Mapping[str, Any], now: float | None = None) -> bool:
    """Whether the request carries a signature that the secret and this body produce. `now` is in milliseconds."""
    at = time.time() * 1000 if now is None else now
    body = raw.encode() if isinstance(raw, str) else bytes(raw)

    def header(name: str) -> str | None:
        value = headers.get(name.lower())
        return value[0] if isinstance(value, (list, tuple)) and value else value if isinstance(value, str) else None

    if signature.scheme == "standard":
        # standardwebhooks.com: the id, the time and the body are signed together, and the secret is base64.
        id, moment, given = header("webhook-id"), header("webhook-timestamp"), header("webhook-signature")
        secret = _from_base64(signature.secret.removeprefix("whsec_"))
        if not id or not given or secret is None or not _recent(moment, at):
            return False
        expected = _hmac(secret, f"{id}.{moment}.", body)
        # The header may carry several signatures, while the sender changes its secret.
        return any(one.startswith("v1,") and _same(expected, _from_base64(one[3:])) for one in given.split(" "))

    if signature.scheme == "stripe":
        parts = [part.strip().split("=") for part in (header("stripe-signature") or "").split(",")]
        moment = next((part[1] for part in parts if part[0] == "t" and len(part) > 1), None)
        if not _recent(moment, at):
            return False
        expected = _hmac(signature.secret.encode(), f"{moment}.", body)
        return any(part[0] == "v1" and _same(expected, _from_hex(part[1] if len(part) > 1 else "")) for part in parts)

    if signature.scheme == "github":
        name, prefix, encoding = "x-hub-signature-256", "sha256=", "hex"
    else:
        name, prefix, encoding = signature.header or "", signature.prefix or "", signature.encoding or "hex"
    given = header(name)
    if given is None or not given.startswith(prefix):
        return False
    expected = _hmac(signature.secret.encode(), "", body)
    text = given[len(prefix) :]
    return _same(expected, _from_hex(text) if encoding == "hex" else _from_base64(text))
