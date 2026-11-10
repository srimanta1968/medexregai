"""Settings from the environment. Limits keep one hostile file from exhausting the sandbox."""

from __future__ import annotations

import os
from dataclasses import dataclass


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name, '').strip()
    if not raw:
        return default
    value = int(raw)
    if value <= 0:
        raise ValueError(f'{name} must be a positive integer')
    return value


@dataclass(frozen=True)
class Settings:
    # Shared secret the worker sends in X-Docproc-Key. Required: the service refuses to start without it.
    api_key: str
    max_bytes: int
    parse_timeout_s: int
    # Pages, slides or sheets per file.
    max_units: int
    max_rows_per_sheet: int
    # Office files are zip archives: refuse zip bombs before opening them.
    max_zip_entries: int
    max_zip_uncompressed: int
    max_zip_ratio: int
    max_location_chars: int


def load_settings() -> Settings:
    key = os.environ.get('DOCPROC_API_KEY', '')
    if len(key) < 24:
        raise RuntimeError('DOCPROC_API_KEY must be set (at least 24 characters)')
    return Settings(
        api_key=key,
        max_bytes=_int('DOCPROC_MAX_BYTES', 100 * 1024 * 1024),
        parse_timeout_s=_int('DOCPROC_PARSE_TIMEOUT_S', 120),
        max_units=_int('DOCPROC_MAX_UNITS', 3000),
        max_rows_per_sheet=_int('DOCPROC_MAX_ROWS_PER_SHEET', 50_000),
        max_zip_entries=_int('DOCPROC_MAX_ZIP_ENTRIES', 10_000),
        max_zip_uncompressed=_int('DOCPROC_MAX_ZIP_UNCOMPRESSED', 1024 * 1024 * 1024),
        max_zip_ratio=_int('DOCPROC_MAX_ZIP_RATIO', 200),
        max_location_chars=_int('DOCPROC_MAX_LOCATION_CHARS', 20_000),
    )
