"""Upload allowlist: extension → MIME → magic-byte checks.

Native extraction is preferred; OCR applies later for weak/image content.
Legacy binary Office (.doc/.xls/.ppt) is accepted and converted via
LibreOffice when available.
"""

from __future__ import annotations

import zipfile
from dataclasses import dataclass
from pathlib import Path


class SecurityValidationError(Exception):
    """Raised when an uploaded file fails lightweight security checks.

    These are signature/extension/MIME allowlist checks, not antivirus
    scanning.
    """


@dataclass(frozen=True)
class UploadTypeSpec:
    kind: str
    extension: str
    content_type: str
    allowed_content_types: frozenset[str]
    # None = no magic-byte gate (plain text family).
    signature: bytes | None = None
    # Alternate magic prefixes (e.g. TIFF endianness).
    alt_signatures: tuple[bytes, ...] = ()
    # For formats where the header is not a pure prefix (WEBP).
    requires_riff_webp: bool = False
    # OOXML package must contain this zip member.
    ooxml_member: str | None = None


def _ooxml(
    *,
    kind: str,
    extension: str,
    content_type: str,
    member: str,
    extra_types: frozenset[str] = frozenset(),
) -> UploadTypeSpec:
    return UploadTypeSpec(
        kind=kind,
        extension=extension,
        content_type=content_type,
        allowed_content_types=frozenset(
            {
                content_type,
                "application/octet-stream",
                "application/zip",
            }
            | set(extra_types)
        ),
        signature=b"PK\x03\x04",
        ooxml_member=member,
    )


UPLOAD_TYPES: dict[str, UploadTypeSpec] = {
    ".pdf": UploadTypeSpec(
        kind="pdf",
        extension=".pdf",
        content_type="application/pdf",
        allowed_content_types=frozenset(
            {
                "application/pdf",
                "application/x-pdf",
                "application/octet-stream",
            }
        ),
        signature=b"%PDF-",
    ),
    ".docx": _ooxml(
        kind="docx",
        extension=".docx",
        content_type=(
            "application/vnd.openxmlformats-officedocument"
            ".wordprocessingml.document"
        ),
        member="word/document.xml",
    ),
    ".xlsx": _ooxml(
        kind="xlsx",
        extension=".xlsx",
        content_type=(
            "application/vnd.openxmlformats-officedocument"
            ".spreadsheetml.sheet"
        ),
        member="xl/workbook.xml",
        extra_types=frozenset(
            {
                "application/vnd.ms-excel",
            }
        ),
    ),
    # Macro-enabled workbook: read like XLSX; the VBA project is never
    # loaded or run (openpyxl keep_vba=False).
    ".xlsm": _ooxml(
        kind="xlsx",
        extension=".xlsm",
        content_type="application/vnd.ms-excel.sheet.macroEnabled.12",
        member="xl/workbook.xml",
        extra_types=frozenset(
            {
                # Supplied types are compared lowercased.
                "application/vnd.ms-excel.sheet.macroenabled.12",
                "application/vnd.ms-excel",
                "application/vnd.openxmlformats-officedocument"
                ".spreadsheetml.sheet",
            }
        ),
    ),
    ".ods": UploadTypeSpec(
        kind="ods",
        extension=".ods",
        content_type="application/vnd.oasis.opendocument.spreadsheet",
        allowed_content_types=frozenset(
            {
                "application/vnd.oasis.opendocument.spreadsheet",
                "application/zip",
                "application/octet-stream",
            }
        ),
        signature=b"PK\x03\x04",
        ooxml_member="content.xml",
    ),
    ".pptx": _ooxml(
        kind="pptx",
        extension=".pptx",
        content_type=(
            "application/vnd.openxmlformats-officedocument"
            ".presentationml.presentation"
        ),
        member="ppt/presentation.xml",
    ),
    ".doc": UploadTypeSpec(
        kind="legacy_office",
        extension=".doc",
        content_type="application/msword",
        allowed_content_types=frozenset(
            {
                "application/msword",
                "application/octet-stream",
            }
        ),
        signature=b"\xd0\xcf\x11\xe0",
    ),
    ".xls": UploadTypeSpec(
        kind="legacy_office",
        extension=".xls",
        content_type="application/vnd.ms-excel",
        allowed_content_types=frozenset(
            {
                "application/vnd.ms-excel",
                "application/octet-stream",
            }
        ),
        signature=b"\xd0\xcf\x11\xe0",
    ),
    ".ppt": UploadTypeSpec(
        kind="legacy_office",
        extension=".ppt",
        content_type="application/vnd.ms-powerpoint",
        allowed_content_types=frozenset(
            {
                "application/vnd.ms-powerpoint",
                "application/octet-stream",
            }
        ),
        signature=b"\xd0\xcf\x11\xe0",
    ),
    ".txt": UploadTypeSpec(
        kind="text",
        extension=".txt",
        content_type="text/plain",
        allowed_content_types=frozenset(
            {"text/plain", "application/octet-stream"}
        ),
        signature=None,
    ),
    ".csv": UploadTypeSpec(
        kind="csv",
        extension=".csv",
        content_type="text/csv",
        allowed_content_types=frozenset(
            {
                "text/csv",
                "application/csv",
                "text/plain",
                "application/octet-stream",
            }
        ),
        signature=None,
    ),
    ".tsv": UploadTypeSpec(
        kind="csv",
        extension=".tsv",
        content_type="text/tab-separated-values",
        allowed_content_types=frozenset(
            {
                "text/tab-separated-values",
                "text/tsv",
                "text/csv",
                "text/plain",
                "application/octet-stream",
            }
        ),
        signature=None,
    ),
    ".json": UploadTypeSpec(
        kind="json",
        extension=".json",
        content_type="application/json",
        allowed_content_types=frozenset(
            {
                "application/json",
                "text/json",
                "text/plain",
                "application/octet-stream",
            }
        ),
        signature=None,
    ),
    ".eml": UploadTypeSpec(
        kind="email",
        extension=".eml",
        content_type="message/rfc822",
        allowed_content_types=frozenset(
            {
                "message/rfc822",
                "text/plain",
                "application/octet-stream",
            }
        ),
        signature=None,
    ),
    # A container: never stored as a document; its files are unpacked
    # (with limits, app/services/containers.py) into documents of their own.
    ".zip": UploadTypeSpec(
        kind="archive",
        extension=".zip",
        content_type="application/zip",
        allowed_content_types=frozenset(
            {
                "application/zip",
                "application/x-zip-compressed",
                "application/x-zip",
                "multipart/x-zip",
                "application/octet-stream",
            }
        ),
        signature=b"PK\x03\x04",
    ),
    ".html": UploadTypeSpec(
        kind="html",
        extension=".html",
        content_type="text/html",
        allowed_content_types=frozenset(
            {
                "text/html",
                "application/xhtml+xml",
                "text/plain",
                "application/octet-stream",
            }
        ),
        signature=None,
    ),
    ".htm": UploadTypeSpec(
        kind="html",
        extension=".htm",
        content_type="text/html",
        allowed_content_types=frozenset(
            {
                "text/html",
                "application/xhtml+xml",
                "text/plain",
                "application/octet-stream",
            }
        ),
        signature=None,
    ),
    ".xml": UploadTypeSpec(
        kind="xml",
        extension=".xml",
        content_type="application/xml",
        allowed_content_types=frozenset(
            {
                "application/xml",
                "text/xml",
                "text/plain",
                "application/octet-stream",
            }
        ),
        signature=None,
    ),
    ".rtf": UploadTypeSpec(
        kind="rtf",
        extension=".rtf",
        content_type="application/rtf",
        allowed_content_types=frozenset(
            {
                "application/rtf",
                "text/rtf",
                "text/plain",
                "application/octet-stream",
            }
        ),
        signature=b"{\\rtf",
    ),
    ".png": UploadTypeSpec(
        kind="image",
        extension=".png",
        content_type="image/png",
        allowed_content_types=frozenset(
            {"image/png", "application/octet-stream"}
        ),
        signature=b"\x89PNG\r\n\x1a\n",
    ),
    ".jpg": UploadTypeSpec(
        kind="image",
        extension=".jpg",
        content_type="image/jpeg",
        allowed_content_types=frozenset(
            {"image/jpeg", "application/octet-stream"}
        ),
        signature=b"\xff\xd8\xff",
    ),
    ".jpeg": UploadTypeSpec(
        kind="image",
        extension=".jpeg",
        content_type="image/jpeg",
        allowed_content_types=frozenset(
            {"image/jpeg", "application/octet-stream"}
        ),
        signature=b"\xff\xd8\xff",
    ),
    ".tif": UploadTypeSpec(
        kind="image",
        extension=".tif",
        content_type="image/tiff",
        allowed_content_types=frozenset(
            {"image/tiff", "image/tif", "application/octet-stream"}
        ),
        signature=b"II*\x00",
        alt_signatures=(b"MM\x00*",),
    ),
    ".tiff": UploadTypeSpec(
        kind="image",
        extension=".tiff",
        content_type="image/tiff",
        allowed_content_types=frozenset(
            {"image/tiff", "image/tif", "application/octet-stream"}
        ),
        signature=b"II*\x00",
        alt_signatures=(b"MM\x00*",),
    ),
    ".bmp": UploadTypeSpec(
        kind="image",
        extension=".bmp",
        content_type="image/bmp",
        allowed_content_types=frozenset(
            {
                "image/bmp",
                "image/x-ms-bmp",
                "application/octet-stream",
            }
        ),
        signature=b"BM",
    ),
    ".webp": UploadTypeSpec(
        kind="image",
        extension=".webp",
        content_type="image/webp",
        allowed_content_types=frozenset(
            {"image/webp", "application/octet-stream"}
        ),
        signature=b"RIFF",
        requires_riff_webp=True,
    ),
}

SUPPORTED_TYPE_LABEL = (
    "PDF, DOCX, DOC, XLSX, XLSM, XLS, ODS, PPTX, PPT, TXT, CSV, TSV, JSON, "
    "RTF, HTML, XML, EML, ZIP, PNG, JPG, TIFF, BMP, WEBP"
)

# Kinds whose text/tables are ingested at upload into DocumentPage rows.
NATIVE_PAGE_KINDS = frozenset(
    {
        "docx", "xlsx", "ods", "pptx", "text", "csv", "json", "html", "xml",
        "rtf", "email",
    }
)

# Kinds that hold other files rather than content of their own.
CONTAINER_KINDS = frozenset({"archive"})

RASTER_EXTENSIONS = frozenset(
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".tif",
        ".tiff",
        ".bmp",
        ".webp",
    }
)


def resolve_upload_type(extension: str) -> UploadTypeSpec:
    spec = UPLOAD_TYPES.get(extension.lower())

    if spec is None:
        raise SecurityValidationError(
            "Unsupported file type. Supported types: "
            f"{SUPPORTED_TYPE_LABEL}."
        )

    return spec


def detect_kind_from_bytes(first_chunk: bytes) -> str | None:
    """Best-effort content sniff — used when extension/signature disagree."""

    if first_chunk.startswith(b"%PDF-"):
        return "pdf"
    if first_chunk.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if first_chunk.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if first_chunk.startswith(b"BM"):
        return "bmp"
    if first_chunk.startswith(b"II*\x00") or first_chunk.startswith(b"MM\x00*"):
        return "tiff"
    if (
        first_chunk.startswith(b"RIFF")
        and len(first_chunk) >= 12
        and first_chunk[8:12] == b"WEBP"
    ):
        return "webp"
    if first_chunk.startswith(b"{\\rtf"):
        return "rtf"
    if first_chunk.startswith(b"\xd0\xcf\x11\xe0"):
        return "legacy_office"
    if first_chunk.startswith(b"PK\x03\x04"):
        return "ooxml_zip"
    return None


def validate_signature(spec: UploadTypeSpec, first_chunk: bytes) -> None:
    if spec.signature is None:
        # Plain-text family: still reject strong binary signatures that
        # clearly belong to another format (signature wins over .txt/.csv).
        sniffed = detect_kind_from_bytes(first_chunk)
        if sniffed in {
            "pdf",
            "png",
            "jpeg",
            "bmp",
            "tiff",
            "webp",
            "legacy_office",
            "ooxml_zip",
        }:
            raise SecurityValidationError(
                "File content does not match the declared extension "
                f"({spec.extension}). Detected content looks like {sniffed}."
            )
        return

    if spec.requires_riff_webp:
        if not (
            first_chunk.startswith(b"RIFF")
            and len(first_chunk) >= 12
            and first_chunk[8:12] == b"WEBP"
        ):
            sniffed = detect_kind_from_bytes(first_chunk)
            detail = (
                f" Detected content looks like {sniffed}."
                if sniffed
                else ""
            )
            raise SecurityValidationError(
                "The file does not contain a valid WEBP signature."
                + detail
            )
        return

    prefixes = (spec.signature,) + spec.alt_signatures
    if not any(first_chunk.startswith(prefix) for prefix in prefixes):
        sniffed = detect_kind_from_bytes(first_chunk)
        detail = (
            f" Detected content looks like {sniffed}."
            if sniffed and sniffed != spec.kind
            else ""
        )
        raise SecurityValidationError(
            "The file does not contain a valid "
            f"{spec.kind.upper()} signature."
            + detail
        )


def validate_content_type(spec: UploadTypeSpec, content_type: str) -> None:
    if content_type.lower() not in spec.allowed_content_types:
        raise SecurityValidationError(
            "The uploaded file has an unsupported content "
            "type for its extension."
        )


def validate_ooxml_structure(file_path: Path, member: str, label: str) -> None:
    try:
        with zipfile.ZipFile(file_path) as archive:
            if member not in archive.namelist():
                raise SecurityValidationError(
                    f"The file is a zip archive but not a valid {label}."
                )
    except zipfile.BadZipFile as exc:
        raise SecurityValidationError(
            f"The file does not contain a valid {label} archive."
        ) from exc


def validate_docx_structure(file_path: Path) -> None:
    validate_ooxml_structure(file_path, "word/document.xml", "DOCX")


def validate_xlsx_structure(file_path: Path) -> None:
    validate_ooxml_structure(file_path, "xl/workbook.xml", "XLSX")


def validate_ods_structure(file_path: Path) -> None:
    """An ODF spreadsheet: content.xml plus an uncompressed 'mimetype'
    member naming the spreadsheet type (a renamed .odt is refused)."""

    validate_ooxml_structure(file_path, "content.xml", "ODS")
    with zipfile.ZipFile(file_path) as archive:
        try:
            mimetype = archive.read("mimetype")[:100].strip()
        except KeyError:
            mimetype = b""
    if mimetype != b"application/vnd.oasis.opendocument.spreadsheet":
        raise SecurityValidationError(
            "The file is a zip archive but not a valid ODS spreadsheet."
        )


def validate_pptx_structure(file_path: Path) -> None:
    validate_ooxml_structure(
        file_path, "ppt/presentation.xml", "PPTX"
    )
