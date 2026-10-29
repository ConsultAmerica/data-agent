"""Unpack ZIP archives and email attachments into files to ingest.

Containers are untrusted, so every limit is enforced on bytes actually
read, not on sizes the archive declares:

- entry count, accepted-file count, per-file size and total size
  (Settings.container_*);
- a compression ratio above container_max_ratio is treated as a zip bomb;
- password-protected entries, hidden/system files (__MACOSX, .DS_Store,
  Office lock files) and unsupported types are skipped and reported;
- archives inside an archive are not unpacked. An email inside a ZIP is
  ingested, and its own attachments are unpacked one level down; anything
  deeper is reported, not opened.

Member names are display names only: files are always stored under a
generated id, never at a path taken from the container.
"""

from __future__ import annotations

import zipfile
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from app.services.security_validation import UPLOAD_TYPES, CONTAINER_KINDS

# Document.parent_relationship_type of a file attached to an email.
EMAIL_ATTACHMENT_RELATIONSHIP = "email_attachment"

_CHUNK = 1024 * 1024
# Ratios this high only matter once the file is big enough to hurt.
_RATIO_MIN_BYTES = 1024 * 1024
_SYSTEM_PREFIXES = ("__MACOSX/",)
_SYSTEM_NAMES = frozenset({".ds_store", "thumbs.db", "desktop.ini"})


class ContainerError(ValueError):
    """The container itself is unreadable or over a hard limit."""


@dataclass(frozen=True)
class ContainerLimits:
    max_entries: int
    max_files: int
    max_member_bytes: int
    max_total_bytes: int
    max_ratio: int

    @classmethod
    def from_settings(cls, settings) -> ContainerLimits:
        return cls(
            max_entries=settings.container_max_entries,
            max_files=settings.container_max_files,
            max_member_bytes=settings.max_upload_mb * 1024 * 1024,
            max_total_bytes=settings.container_max_total_mb * 1024 * 1024,
            max_ratio=settings.container_max_ratio,
        )


@dataclass
class ContainerMember:
    """One file found in a container: its bytes, or why it was skipped."""

    filename: str
    path: str
    data: bytes | None = None
    skipped_reason: str | None = None


def _type_problem(filename: str) -> str | None:
    suffix = Path(filename).suffix.lower()
    spec = UPLOAD_TYPES.get(suffix)
    if spec is None:
        return f"Unsupported file type ({suffix or 'no extension'})."
    if spec.kind in CONTAINER_KINDS:
        return "Archives inside an archive are not unpacked."
    return None


def _is_system_file(path: str) -> bool:
    name = PurePosixPath(path).name
    return (
        path.startswith(_SYSTEM_PREFIXES)
        or "/__MACOSX/" in path
        or name.lower() in _SYSTEM_NAMES
        or name.startswith("._")
        or name.startswith("~$")
    )


def iter_zip_members(path: Path, limits: ContainerLimits) -> Iterator[ContainerMember]:
    """Yield each file of a ZIP, one at a time (one file's bytes in memory)."""

    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise ContainerError("The file is not a valid ZIP archive.") from exc

    with archive:
        entries = archive.infolist()
        if len(entries) > limits.max_entries:
            raise ContainerError(
                f"The archive has {len(entries)} entries; at most "
                f"{limits.max_entries} are accepted."
            )
        declared_total = sum(info.file_size for info in entries)
        if declared_total > limits.max_total_bytes:
            raise ContainerError(
                "The archive expands to more than "
                f"{limits.max_total_bytes // (1024 * 1024)} MB."
            )

        accepted = 0
        total_read = 0
        for info in entries:
            if info.is_dir() or _is_system_file(info.filename):
                continue
            name = PurePosixPath(info.filename.replace("\\", "/")).name
            member = ContainerMember(filename=name, path=info.filename)

            if info.flag_bits & 0x1:
                member.skipped_reason = "Password-protected files are not opened."
            elif (problem := _type_problem(name)) is not None:
                member.skipped_reason = problem
            elif accepted >= limits.max_files:
                member.skipped_reason = (
                    f"Only the first {limits.max_files} files of an archive are imported."
                )
            elif info.file_size > limits.max_member_bytes:
                member.skipped_reason = "The file exceeds the upload-size limit."
            elif (
                info.file_size > _RATIO_MIN_BYTES
                and info.file_size > limits.max_ratio * max(info.compress_size, 1)
            ):
                member.skipped_reason = "Unusually high compression ratio (possible zip bomb)."
            else:
                try:
                    data = _read_bounded(archive, info, limits.max_member_bytes)
                except ContainerError as exc:
                    member.skipped_reason = str(exc)
                    yield member
                    continue
                if data is None:
                    member.skipped_reason = "The file exceeds the upload-size limit."
                elif total_read + len(data) > limits.max_total_bytes:
                    member.skipped_reason = "The archive's total size limit was reached."
                elif not data:
                    member.skipped_reason = "The file is empty."
                else:
                    total_read += len(data)
                    accepted += 1
                    member.data = data
            yield member


def _read_bounded(archive: zipfile.ZipFile, info: zipfile.ZipInfo, limit: int) -> bytes | None:
    """The entry's bytes, or None as soon as more than `limit` come out
    (the declared size can lie)."""

    chunks: list[bytes] = []
    size = 0
    try:
        with archive.open(info) as handle:
            while chunk := handle.read(_CHUNK):
                size += len(chunk)
                if size > limit:
                    return None
                chunks.append(chunk)
    except (zipfile.BadZipFile, NotImplementedError, RuntimeError, OSError, EOFError) as exc:
        # Corrupt data, a failed CRC, or an unsupported compression method.
        raise ContainerError("The file could not be read from the archive.") from exc
    return b"".join(chunks)


# ── Email attachments ────────────────────────────────────────────────


def _attachment_parts(message) -> Iterator[tuple[str, object]]:
    """(filename, part) for every attachment, without descending into an
    attached email (that one is reported, not unpacked)."""

    body = message.get_body(preferencelist=("plain", "html"))

    def visit(part):
        if part is body:
            return
        content_type = part.get_content_type()
        filename = part.get_filename()
        if content_type == "message/rfc822":
            yield (filename or "attached-message.eml"), part
            return
        if part.is_multipart():
            for child in part.iter_parts():
                yield from visit(child)
            return
        if not filename:
            return
        # Inline images are signatures and logos, not documents.
        if part.get_content_disposition() == "inline" and part.get_content_maintype() == "image":
            return
        yield filename, part

    if message.is_multipart():
        for child in message.iter_parts():
            yield from visit(child)


def email_attachment_names(message) -> list[str]:
    return [PurePosixPath(name.replace("\\", "/")).name for name, _ in _attachment_parts(message)]


def iter_email_attachments(message, limits: ContainerLimits) -> Iterator[ContainerMember]:
    accepted = 0
    total = 0
    for raw_name, part in _attachment_parts(message):
        name = PurePosixPath(raw_name.replace("\\", "/")).name
        member = ContainerMember(filename=name, path=raw_name)
        if part.get_content_type() == "message/rfc822":
            member.skipped_reason = "Emails attached to an email are not unpacked."
        elif (problem := _type_problem(name)) is not None:
            member.skipped_reason = problem
        elif Path(name).suffix.lower() == ".eml":
            member.skipped_reason = "Emails attached to an email are not unpacked."
        elif accepted >= limits.max_files:
            member.skipped_reason = (
                f"Only the first {limits.max_files} attachments of an email are imported."
            )
        else:
            data = part.get_payload(decode=True) or b""
            if len(data) > limits.max_member_bytes:
                member.skipped_reason = "The file exceeds the upload-size limit."
            elif total + len(data) > limits.max_total_bytes:
                member.skipped_reason = "The email's total attachment size limit was reached."
            elif not data:
                member.skipped_reason = "The attachment is empty."
            else:
                total += len(data)
                accepted += 1
                member.data = data
        yield member
