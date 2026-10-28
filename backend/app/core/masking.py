"""Masking of identifiers that must never be logged in full.

`mask_identifier` is for code that deliberately shows an identifier
(keep the last few characters). `redact_text` is the safety net applied
to every log message (see `install_log_redaction`): it masks shapes that
are almost always personal or financial identifiers — US SSNs, long digit
runs (account, routing, card numbers), IBANs and MRZ lines. It is not a
substitute for not logging document values in the first place.
"""

from __future__ import annotations

import logging
import re

MASK_CHAR = "*"  # ASCII: Windows consoles (cp1252) can't encode "•"

_SSN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")
# 9+ digits, optionally grouped by single spaces/hyphens (card numbers,
# bank accounts, routing numbers). Runs touching letters, ":" or "."
# (UUIDs, times like "2026-10-26 14:25", decimal amounts) are left alone.
_LONG_DIGITS = re.compile(r"(?<![\w.:-])\d(?:[ -]?\d){8,}(?![\w.:-])")
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b")
# A machine-readable-zone line: long run of MRZ characters with fillers.
_MRZ_LINE = re.compile(r"[A-Z0-9<]{25,}<<[A-Z0-9<]*")


def mask_identifier(value: str | None, keep: int = 4) -> str:
    """'123456789' -> '*****6789'. Short values are fully masked."""

    text = (value or "").strip()
    if not text:
        return ""
    compact = re.sub(r"[\s-]", "", text)
    if len(compact) <= keep:
        return MASK_CHAR * len(compact)
    return MASK_CHAR * 5 + compact[-keep:]


def _mask_match(match: re.Match) -> str:
    return mask_identifier(match.group(0))


def redact_text(text: str) -> str:
    if not text:
        return text
    text = _MRZ_LINE.sub("[MRZ redacted]", text)
    text = _IBAN.sub(_mask_match, text)
    text = _SSN.sub(_mask_match, text)
    return _LONG_DIGITS.sub(_mask_match, text)


_installed = False


def install_log_redaction() -> None:
    """Redact every log record's message at creation, whichever logger or
    handler emits it. Exception tracebacks are not rewritten."""

    global _installed
    if _installed:
        return
    previous = logging.getLogRecordFactory()

    def factory(*args, **kwargs):
        record = previous(*args, **kwargs)
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 - leave a malformed record as is
            return record
        redacted = redact_text(message)
        if redacted != message:
            record.msg = redacted
            record.args = None
        return record

    logging.setLogRecordFactory(factory)
    _installed = True
