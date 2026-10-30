"""The table-reading worker pool fits the container it runs in."""

from __future__ import annotations

import pytest

from app.core.config import get_settings
from app.services import generic_table_extractor as gte


@pytest.fixture
def container(monkeypatch):
    files: dict[str, str] = {}
    monkeypatch.setattr(gte, "_read_text", lambda path: files.get(path))
    monkeypatch.setattr(gte.os, "cpu_count", lambda: 64)  # the host's, not ours
    monkeypatch.setattr(gte.os, "sched_getaffinity", lambda pid: set(range(64)), raising=False)
    monkeypatch.setattr(get_settings(), "table_prefetch_workers", None)
    return files


def test_a_512_mb_instance_reads_tables_sequentially(container) -> None:
    container["/sys/fs/cgroup/memory.max"] = str(512 * 1024 * 1024)
    assert gte.prefetch_worker_count() == 1  # < 2: the prefetch stays off


def test_cpu_quota_not_host_cores_bounds_the_pool(container) -> None:
    container["/sys/fs/cgroup/memory.max"] = str(8 * 1024 * 1024 * 1024)
    container["/sys/fs/cgroup/cpu.max"] = "200000 100000"  # 2 CPUs
    assert gte.available_cpus() == 2
    assert gte.prefetch_worker_count() == 1


def test_a_large_container_keeps_parallel_reading(container) -> None:
    container["/sys/fs/cgroup/memory.max"] = str(4 * 1024 * 1024 * 1024)
    container["/sys/fs/cgroup/cpu.max"] = "max 100000"
    assert gte.prefetch_worker_count() == gte.MAX_TABLE_WORKERS


def test_cgroup_v1_and_unlimited_memory(container) -> None:
    container["/sys/fs/cgroup/memory/memory.limit_in_bytes"] = str(1 << 62)  # "unlimited"
    assert gte.container_memory_limit_mb() is None
    container["/sys/fs/cgroup/memory/memory.limit_in_bytes"] = str(1024 * 1024 * 1024)
    assert gte.container_memory_limit_mb() == 1024
    assert gte.prefetch_worker_count() == min(gte.MAX_TABLE_WORKERS, (1024 - gte.RESERVED_MEMORY_MB) // gte.WORKER_MEMORY_MB)


def test_the_setting_overrides_detection(container, monkeypatch) -> None:
    container["/sys/fs/cgroup/memory.max"] = str(512 * 1024 * 1024)
    monkeypatch.setattr(get_settings(), "table_prefetch_workers", 3)
    assert gte.prefetch_worker_count() == 3
    monkeypatch.setattr(get_settings(), "table_prefetch_workers", 0)
    assert gte.prefetch_worker_count() == 0
