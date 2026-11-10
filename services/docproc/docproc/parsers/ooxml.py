"""Word, Excel and PowerPoint, read natively so locations are exact (cell ranges, slide numbers).

DOCX has no pages until it is laid out, so DOCX passages are located by heading path;
page numbers are added when the LibreOffice render step runs (F7.2 sandbox task).
"""

from __future__ import annotations

import datetime as dt
import io
import re
from itertools import zip_longest
from typing import Any, Iterable, Optional

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

from ..config import Settings
from ..errors import FileUnreadable
from .common import Collector, section_path
from .profile import SheetProfiler, raw_data_profile

_HEADING = re.compile(r'^(?:heading|überschrift|titre|título)\s*(\d)$', re.IGNORECASE)
NO_HEADING = '(before first heading)'


# ---------------------------------------------------------------- DOCX
def _heading_level(paragraph: Any) -> Optional[int]:
    name = (paragraph.style.name if paragraph.style is not None else '') or ''
    if name.lower() == 'title':
        return 0
    m = _HEADING.match(name.strip())
    return int(m.group(1)) if m else None


def _table_text(table: Any) -> str:
    lines = []
    for row in table.rows:
        seen: set[int] = set()
        cells = []
        for cell in row.cells:
            # Merged cells repeat the same underlying element: keep the first.
            if id(cell._tc) in seen:
                continue
            seen.add(id(cell._tc))
            cells.append(' '.join(cell.text.split()))
        if any(cells):
            lines.append(' | '.join(cells))
    return '\n'.join(lines)


def parse_docx(data: bytes, settings: Settings) -> dict[str, Any]:
    from docx import Document
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    try:
        doc = Document(io.BytesIO(data))
    except Exception as exc:  # python-docx raises several types for damaged packages
        raise FileUnreadable(f'The Word file could not be read: {type(exc).__name__}') from exc
    out = Collector(settings.max_location_chars)
    stack: list[str] = []
    for child in doc.element.body.iterchildren():
        tag = child.tag.rsplit('}', 1)[-1]
        if tag == 'p':
            para = Paragraph(child, doc)
            text = para.text
            level = _heading_level(para)
            if level is not None and text.strip():
                del stack[max(level - 1, 0) :]
                stack.append(' '.join(text.split()))
            out.add('paragraph', text, sectionPath=section_path(stack) or NO_HEADING)
        elif tag == 'tbl':
            out.add('table', _table_text(Table(child, doc)), sectionPath=section_path(stack) or NO_HEADING)
    if doc.inline_shapes and not out.locations:
        out.warn('The document holds only images; text inside images needs OCR')
    return {'parser': 'python-docx', 'unit_count': 1, 'locations': out.locations, 'warnings': out.warnings}


# ---------------------------------------------------------------- XLSX
def _value(v: Any) -> str:
    if v is None:
        return ''
    if isinstance(v, bool):
        return 'TRUE' if v else 'FALSE'
    if isinstance(v, float):
        return f'{v:.15g}'
    if isinstance(v, dt.datetime):
        return v.date().isoformat() if v.time() == dt.time(0) else v.isoformat(sep=' ')
    if isinstance(v, (dt.date, dt.time)):
        return v.isoformat()
    return ' '.join(str(v).split())


def parse_xlsx(data: bytes, settings: Settings) -> dict[str, Any]:
    try:
        # data_only: the values Excel last calculated. The second copy holds the formulas, so a
        # formula with no saved value (file never recalculated) is shown instead of dropped.
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        wb_formulas = load_workbook(io.BytesIO(data), read_only=True, data_only=False)
    except Exception as exc:
        raise FileUnreadable(f'The Excel file could not be read: {type(exc).__name__}') from exc
    out = Collector(settings.max_location_chars)
    profilers: list[SheetProfiler] = []
    try:
        sheets = wb.worksheets[: settings.max_units]
        if len(wb.worksheets) > settings.max_units:
            out.warn(f'Only the first {settings.max_units} sheets were read')
        for ws, ws_f in zip(sheets, wb_formulas.worksheets):
            title = ws.title[:100]
            if ws.sheet_state != 'visible':
                out.warn(f'Sheet "{title}" is hidden; it was read anyway')
            header: Optional[list[str]] = None
            rows = 0
            uncalculated = 0
            profiler = SheetProfiler(title)
            profilers.append(profiler)
            pairs = zip_longest(ws.iter_rows(min_row=1, min_col=1, values_only=True), ws_f.iter_rows(min_row=1, min_col=1, values_only=True), fillvalue=())
            for r, (row, row_f) in enumerate(pairs, start=1):
                values = [_value(v) for v in row]
                for i, formula in enumerate(row_f):
                    if isinstance(formula, str) and formula.startswith('=') and (i >= len(values) or not values[i]):
                        values.extend([''] * (i + 1 - len(values)))
                        values[i] = f'[formula {formula}, no saved value]'
                        uncalculated += 1
                filled = [i for i, v in enumerate(values) if v]
                if not filled:
                    continue
                rows += 1
                if rows > settings.max_rows_per_sheet:
                    out.warn(f'Sheet "{title}": only the first {settings.max_rows_per_sheet} rows were read')
                    break
                # Typed values (numbers, dates) for the profile; formulas without a saved value count as empty.
                typed = list(row) + [None] * (len(values) - len(row))
                profiler.add_row(r, typed, [get_column_letter(i + 1) for i in range(len(typed))])
                first, last = filled[0], filled[-1]
                cell_range = f'{get_column_letter(first + 1)}{r}:{get_column_letter(last + 1)}{r}'
                if header is None:
                    header = values
                    text = ' | '.join(values[first : last + 1])
                elif len(filled) > 1:
                    text = ' | '.join(
                        f'{header[i]}: {values[i]}' if i < len(header) and header[i] else values[i] for i in filled
                    )
                else:
                    text = values[first]
                out.add('cell', text, sheet=title, cellRange=cell_range)
            if uncalculated:
                out.warn(f'Sheet "{title}": {uncalculated} formula(s) have no saved value; open and save the file in Excel to record them')
    finally:
        wb.close()
        wb_formulas.close()
    return {
        'parser': 'openpyxl',
        'unit_count': len(wb.worksheets),
        'locations': out.locations,
        'warnings': out.warnings,
        'profile': raw_data_profile(profilers),
    }


# ---------------------------------------------------------------- PPTX
def _shape_texts(shapes: Iterable[Any]) -> list[str]:
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    texts: list[str] = []
    ordered = sorted(shapes, key=lambda s: ((s.top or 0), (s.left or 0)))
    for shape in ordered:
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            texts.extend(_shape_texts(shape.shapes))
        elif getattr(shape, 'has_table', False) and shape.has_table:
            rows = [' | '.join(' '.join(c.text.split()) for c in row.cells) for row in shape.table.rows]
            texts.append('\n'.join(r for r in rows if r.strip(' |')))
        elif getattr(shape, 'has_text_frame', False) and shape.has_text_frame:
            texts.append(shape.text_frame.text)
    return texts


def parse_pptx(data: bytes, settings: Settings) -> dict[str, Any]:
    from pptx import Presentation

    try:
        deck = Presentation(io.BytesIO(data))
    except Exception as exc:
        raise FileUnreadable(f'The PowerPoint file could not be read: {type(exc).__name__}') from exc
    out = Collector(settings.max_location_chars)
    slides = list(deck.slides)
    if len(slides) > settings.max_units:
        out.warn(f'Only the first {settings.max_units} slides were read')
    for number, slide in enumerate(slides[: settings.max_units], start=1):
        title_shape = slide.shapes.title
        title = ' '.join(title_shape.text.split()) if title_shape is not None and title_shape.has_text_frame else ''
        others = [s for s in slide.shapes if title_shape is None or s.shape_id != title_shape.shape_id]
        parts = ([title] if title else []) + _shape_texts(others)
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text if slide.notes_slide.notes_text_frame else ''
            if notes.strip():
                parts.append(f'Speaker notes: {notes}')
        out.add('slide', '\n'.join(p for p in parts if p.strip()), slide=number, sectionPath=title[:500] or None)
    return {'parser': 'python-pptx', 'unit_count': len(slides), 'locations': out.locations, 'warnings': out.warnings}
