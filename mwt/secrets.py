"""API keys go through the keyring module. Settings files, SQLite, and logs stay empty of secrets."""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

SERVICE_NAME = "PomiTranslate"


def remember_api_key(account: str, secret: str) -> None:
    import keyring

    keyring.set_password(SERVICE_NAME, account, secret)


def load_api_key(account: str) -> str | None:
    import keyring

    return keyring.get_password(SERVICE_NAME, account)


def save_public_settings(database: Path, *, provider: str, model: str) -> None:
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database)
    try:
        connection.execute("CREATE TABLE IF NOT EXISTS settings (provider TEXT NOT NULL, model TEXT NOT NULL)")
        connection.execute("DELETE FROM settings")
        connection.execute("INSERT INTO settings (provider, model) VALUES (?, ?)", (provider, model))
        connection.commit()
    finally:
        connection.close()


# A partial echo of a key is still a leak: redact every run of this many characters or more.
MIN_PARTIAL_SECRET = 8

# Common credential shapes, so a key other than the active one (or one cut short) is still hidden.
_KEY_PATTERNS = (
    re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9_\-]{6,}"),
    re.compile(r"(?<![A-Za-z0-9])AIza[0-9A-Za-z_\-]{8,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]{8,}"),
)


def _redact_partial(message: str, secret: str) -> str:
    """Replace every stretch of ``message`` that is a substring of ``secret`` at least 8 long."""
    width = MIN_PARTIAL_SECRET
    if len(secret) < width or len(message) < width:
        return message
    grams = {secret[i : i + width] for i in range(len(secret) - width + 1)}
    out: list[str] = []
    cursor = 0
    i = 0
    limit = len(message) - width
    while i <= limit:
        if message[i : i + width] in grams:
            end = i + width
            while end < len(message) and message[i : end + 1] in secret:
                end += 1
            out.append(message[cursor:i])
            out.append("[redacted]")
            cursor = i = end
        else:
            i += 1
    out.append(message[cursor:])
    return "".join(out)


def redact_log(message: str, secret: str) -> str:
    """Hide ``secret`` (whole, or any part of it 8+ characters long) and common key shapes."""
    if not isinstance(message, str):
        message = str(message)
    if secret:
        message = message.replace(secret, "[redacted]")
        message = _redact_partial(message, secret)
    for pattern in _KEY_PATTERNS:
        message = pattern.sub("[redacted]", message)
    return message


def bounded_public_text(message: str, secret: str, limit: int = 600) -> str:
    """Redact the whole text first, then cut it, so a key on the cut line cannot survive."""
    cleaned = redact_log(message, secret)
    cleaned = "".join(ch if ch.isprintable() or ch in "\n\t" else " " for ch in cleaned)
    if len(cleaned) > limit:
        cleaned = cleaned[:limit].rstrip() + "..."
    return cleaned
