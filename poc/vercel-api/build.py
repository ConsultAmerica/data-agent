"""Assemble the deployable proof of concept in .build/: the POC modules and
the application's own ``app`` package, migrations and OCR language data —
never .env files, databases, uploads or tests.

    python poc/vercel-api/build.py        then deploy from poc/vercel-api/.build
"""

from __future__ import annotations

import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[1] / "backend"
OUT = HERE / ".build"
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".env*", "*.db", "*.db-*", "uploads", "tests")


def main() -> None:
    link = OUT / ".vercel"
    kept = None
    if link.exists():
        kept = HERE / ".vercel-link"
        shutil.rmtree(kept, ignore_errors=True)
        shutil.copytree(link, kept)
    # Empty the folder rather than delete it (Windows keeps a handle on an
    # open folder, which makes removing the folder itself fail).
    OUT.mkdir(exist_ok=True)
    for entry in OUT.iterdir():
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink()
    for name in ("poc_api.py", "poc_queue.py", "poc_processing.py", "poc_storage.py", "pyproject.toml", "vercel.json"):
        shutil.copy2(HERE / name, OUT / name)
    shutil.copytree(HERE / "tessdata", OUT / "tessdata")
    shutil.copytree(BACKEND / "app", OUT / "app", ignore=IGNORE)
    shutil.copytree(BACKEND / "migrations", OUT / "migrations", ignore=IGNORE)
    shutil.copy2(BACKEND / "alembic.ini", OUT / "alembic.ini")
    if kept is not None:
        shutil.copytree(kept, link)
        shutil.rmtree(kept, ignore_errors=True)
    # Never upload local credentials (vercel link writes .env.local here).
    (OUT / ".vercelignore").write_text(".env*\n*.db\ntests/\n**/__pycache__/\n", encoding="utf-8")
    for leftover in OUT.glob(".env*"):
        leftover.unlink()
    secrets = [p for p in OUT.rglob("*") if p.name.startswith(".env") or p.suffix == ".db"]
    assert not secrets, f"refusing to ship {secrets}"
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file()) / 2**20
    print(f"built {OUT} ({size:.1f} MB of source and data)")


if __name__ == "__main__":
    main()
