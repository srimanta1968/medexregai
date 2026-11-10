"""CSV / TSV: rows become cell locations on a pseudo-sheet named after the file."""

from __future__ import annotations

import csv
import io
from pathlib import PurePath
from typing import Any

from openpyxl.utils import get_column_letter

from ..config import Settings
from ..errors import FileUnreadable
from .common import Collector


def _decode(data: bytes) -> str:
    for encoding in ('utf-8-sig', 'cp1252'):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise FileUnreadable('The text file is not UTF-8 or Windows-1252')


def parse_csv(data: bytes, file_name: str, settings: Settings) -> dict[str, Any]:
    text = _decode(data)
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=',;\t|')
    except csv.Error:
        dialect = csv.excel
    sheet = (PurePath(file_name).stem or 'data')[:100]
    out = Collector(settings.max_location_chars)
    header: list[str] | None = None
    rows = 0
    for r, row in enumerate(csv.reader(io.StringIO(text), dialect), start=1):
        values = [' '.join(v.split()) for v in row]
        filled = [i for i, v in enumerate(values) if v]
        if not filled:
            continue
        rows += 1
        if rows > settings.max_rows_per_sheet:
            out.warn(f'Only the first {settings.max_rows_per_sheet} rows were read')
            break
        first, last = filled[0], filled[-1]
        cell_range = f'{get_column_letter(first + 1)}{r}:{get_column_letter(last + 1)}{r}'
        if header is None:
            header = values
            line = ' | '.join(values[first : last + 1])
        else:
            line = ' | '.join(f'{header[i]}: {values[i]}' if i < len(header) and header[i] else values[i] for i in filled)
        out.add('cell', line, sheet=sheet, cellRange=cell_range)
    return {'parser': 'csv', 'unit_count': 1, 'locations': out.locations, 'warnings': out.warnings}
