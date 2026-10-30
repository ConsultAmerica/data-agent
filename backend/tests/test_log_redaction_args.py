"""Redaction keeps a log record's arguments when masking them is enough, so
formatters that unpack the arguments (uvicorn's access log) still work."""

import logging

from app.core.masking import install_log_redaction


def test_access_log_arguments_are_redacted_in_place() -> None:
    install_log_redaction()
    record = logging.getLogRecordFactory()(
        "uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
        ("127.0.0.1:1", "GET", "/api/documents/x/pages/1/render?highlight=123456789", "1.1", 200), None,
    )
    assert isinstance(record.args, tuple) and len(record.args) == 5
    client, method, path, version, status = record.args
    assert "123456789" not in record.getMessage() and status == 200
