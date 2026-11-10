"""File profiles (FR-14.4 / FR-14.5).

Raw data (XLSX, CSV): per sheet, the header row, row count and each column's name,
unit, type and range, so a report's claim ("mean 42.0 N, n = 30") can later be
checked against the data it cites.

Drawings (PDF with a text layer, e.g. exported from CAD): the title block in the
bottom-right corner of the first page, read for part number, drawing number,
revision and title. Scanned drawings need OCR (Docling build).
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from typing import Any, Optional

# "Force (N)", "Force [N]", "Temperature, °C", "Length_mm"
_UNIT_IN_BRACKETS = re.compile(r'^(.*?)\s*[\(\[]\s*([^()\[\]]{1,20})\s*[\)\]]\s*$')
_UNIT_AFTER_COMMA = re.compile(r'^(.*?),\s*([^\s,]{1,12})$')
_UNIT_SUFFIX = re.compile(r'^(.*?)[_ ](mm|cm|m|um|µm|N|kN|lbf|kPa|MPa|psi|°C|degC|s|ms|min|h|mL|ml|L|g|mg|kg|%|V|mA|A|Hz|W|J)$')
_NUMBER = re.compile(r'^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$', re.IGNORECASE)
_ISO_DATE = re.compile(r'^\d{4}-\d{2}-\d{2}')

MIN_PROFILE_ROWS = 5


def split_unit(header: str) -> tuple[str, Optional[str]]:
    header = header.strip()
    for pattern in (_UNIT_IN_BRACKETS, _UNIT_AFTER_COMMA, _UNIT_SUFFIX):
        m = pattern.match(header)
        if m and m.group(1).strip():
            return m.group(1).strip(), m.group(2).strip()
    return header, None


def _as_number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and _NUMBER.match(value.strip().replace(',', '')):
        return float(value.strip().replace(',', ''))
    return None


@dataclass
class _Column:
    name: str
    unit: Optional[str]
    letter: str
    non_empty: int = 0
    numbers: int = 0
    dates: int = 0
    total: float = 0.0
    low: Optional[float] = None
    high: Optional[float] = None

    def add(self, value: Any) -> None:
        if value is None or (isinstance(value, str) and not value.strip()):
            return
        self.non_empty += 1
        n = _as_number(value)
        if n is not None:
            self.numbers += 1
            self.total += n
            self.low = n if self.low is None else min(self.low, n)
            self.high = n if self.high is None else max(self.high, n)
        elif isinstance(value, (dt.date, dt.datetime)) or (isinstance(value, str) and _ISO_DATE.match(value)):
            self.dates += 1

    def summary(self) -> dict[str, Any]:
        kind = 'empty'
        if self.non_empty:
            if self.numbers / self.non_empty >= 0.9:
                kind = 'number'
            elif self.dates / self.non_empty >= 0.9:
                kind = 'date'
            else:
                kind = 'text'
        out: dict[str, Any] = {'column': self.letter, 'name': self.name, 'unit': self.unit, 'type': kind, 'nonEmpty': self.non_empty}
        if kind == 'number':
            out.update(min=self.low, max=self.high, mean=round(self.total / self.numbers, 6))
        return out


@dataclass
class SheetProfiler:
    """Fed one row at a time by the XLSX / CSV parsers; first non-empty row is the header."""

    sheet: str
    header_row: Optional[int] = None
    rows: int = 0
    columns: list[_Column] = field(default_factory=list)

    def add_row(self, row_number: int, values: list[Any], letters: list[str]) -> None:
        if not any(v not in (None, '') for v in values):
            return
        if self.header_row is None:
            self.header_row = row_number
            for i, value in enumerate(values):
                name, unit = split_unit(str(value)) if value not in (None, '') else (f'Column {letters[i]}', None)
                self.columns.append(_Column(name=name, unit=unit, letter=letters[i]))
            return
        self.rows += 1
        for i, value in enumerate(values[: len(self.columns)]):
            self.columns[i].add(value)

    def summary(self) -> Optional[dict[str, Any]]:
        used = [c for c in self.columns if c.non_empty]
        # A sheet is "raw data" when it is a real table: two or more columns and a handful of rows.
        if len(used) < 2 or self.rows < MIN_PROFILE_ROWS:
            return None
        return {'sheet': self.sheet, 'headerRow': self.header_row, 'rowCount': self.rows, 'columns': [c.summary() for c in used]}


def raw_data_profile(sheets: list[SheetProfiler]) -> Optional[dict[str, Any]]:
    summaries = [s for s in (p.summary() for p in sheets) if s]
    return {'kind': 'raw_data', 'sheets': summaries} if summaries else None


# ---------------------------------------------------------------- drawings
# Free-text fields end at the next title-block label on the same line, or at the line end.
_NEXT_LABEL = r'(?=\s+(?:SHEET|SCALE|SIZE|REV(?:ISION)?|DWG|DRAWING|PART|DATE|DRAWN|CHECKED|APPROVED|WEIGHT)\b|\s*$)'
_LABELS = {
    'partNumber': re.compile(r'\b(?:PART\s*(?:NO|NUMBER|#)|P\s*/\s*N)\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9._/-]{2,30})', re.IGNORECASE),
    'drawingNumber': re.compile(r'\b(?:DWG|DRAWING)\s*(?:NO|NUMBER|#)\.?\s*[:#]?\s*([A-Z0-9][A-Z0-9._/-]{2,30})', re.IGNORECASE),
    'revision': re.compile(r'\bREV(?:ISION)?\.?\s*[:#]?\s*([A-Z]{1,2}\d?|\d{1,3})\b', re.IGNORECASE),
    'title': re.compile(r'\bTITLE\s*[:#]?\s*([^\n]{3,80}?)' + _NEXT_LABEL, re.IGNORECASE | re.MULTILINE),
    'material': re.compile(r'\bMATERIAL\s*[:#]?\s*([^\n]{2,60}?)' + _NEXT_LABEL, re.IGNORECASE | re.MULTILINE),
}


def title_block(region_text: str) -> Optional[dict[str, str]]:
    """Fields found in a title-block region; None unless a part/drawing number or revision is present."""
    found: dict[str, str] = {}
    for key, pattern in _LABELS.items():
        m = pattern.search(region_text)
        if m:
            found[key] = ' '.join(m.group(1).split()).strip(' :')
    if not ({'partNumber', 'drawingNumber'} & found.keys()) or 'revision' not in found:
        return None
    return found


def region_lines(fragments: list[tuple[float, float, str]]) -> str:
    """Join positioned text fragments (x, y in PDF points, origin bottom-left) into top-to-bottom lines."""
    lines: dict[int, list[tuple[float, str]]] = {}
    for x, y, text in fragments:
        lines.setdefault(round(y / 4), []).append((x, text))
    return '\n'.join(' '.join(t for _, t in sorted(parts)) for _, parts in sorted(lines.items(), key=lambda kv: -kv[0]))
