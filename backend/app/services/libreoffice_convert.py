"""Optional LibreOffice headless conversion for legacy .doc/.xls/.ppt."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path


LEGACY_OFFICE_UNAVAILABLE = (
    "Legacy Office conversion is not available on this deployment."
)


class LibreOfficeConversionError(Exception):
    pass


_LEGACY_TARGET = {
    ".doc": "docx",
    ".xls": "xlsx",
    ".ppt": "pptx",
}


def libreoffice_available() -> bool:
    return shutil.which("soffice") is not None or shutil.which(
        "libreoffice"
    ) is not None


def _soffice_bin() -> str:
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    raise LibreOfficeConversionError(LEGACY_OFFICE_UNAVAILABLE)


def convert_legacy_office(source: Path) -> Path:
    """Convert a legacy Office binary to OOXML beside a temp directory.

    Returns the path to the converted file. Caller owns cleanup of the
    parent temp directory (returned path's parent).
    """

    suffix = source.suffix.lower()
    target_filter = _LEGACY_TARGET.get(suffix)
    if target_filter is None:
        raise LibreOfficeConversionError(
            f"No LibreOffice conversion mapping for {suffix}."
        )

    binary = _soffice_bin()
    out_dir = Path(tempfile.mkdtemp(prefix="dataomatix-lo-"))

    try:
        completed = subprocess.run(
            [
                binary,
                "--headless",
                "--nologo",
                "--nolockcheck",
                "--nodefault",
                "--nofirststartwizard",
                "--convert-to",
                target_filter,
                "--outdir",
                str(out_dir),
                str(source),
            ],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise LibreOfficeConversionError(
            "LibreOffice conversion timed out."
        ) from exc

    if completed.returncode != 0:
        shutil.rmtree(out_dir, ignore_errors=True)
        detail = (completed.stderr or completed.stdout or "").strip()
        raise LibreOfficeConversionError(
            "LibreOffice conversion failed"
            + (f": {detail[:300]}" if detail else ".")
        )

    converted = out_dir / f"{source.stem}.{target_filter}"
    if not converted.exists():
        # LibreOffice may alter the stem; take the first matching file.
        matches = list(out_dir.glob(f"*.{target_filter}"))
        if not matches:
            shutil.rmtree(out_dir, ignore_errors=True)
            raise LibreOfficeConversionError(
                "LibreOffice did not produce a converted file."
            )
        converted = matches[0]

    return converted
