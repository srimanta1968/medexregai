"""PDF: pypdf for the text layer, page by page. Pages without one need OCR (Docling build)."""

from __future__ import annotations

import io
from typing import Any

from ..config import Settings
from ..errors import FileUnreadable
from .common import Collector, clean
from .docling_parser import docling_available, parse_with_docling
from .profile import region_lines, title_block

# A page with fewer characters than this has no usable text layer (a scan, or only images).
MIN_PAGE_CHARS = 20
# Title blocks sit in the bottom-right corner (ASME Y14.1 / ISO 7200): right half, bottom third.
TITLE_BLOCK = (0.5, 0.0, 1.0, 0.35)  # x0, y0, x1, y1 as page fractions, origin bottom-left


def _title_block_region(page) -> str:
    """Text drawn inside the title-block corner of a page, as lines."""
    box = page.mediabox
    width, height = float(box.width), float(box.height)
    left, bottom = float(box.left), float(box.bottom)
    fragments: list[tuple[float, float, str]] = []
    last: list[float] = []

    def visit(text, cm, tm, _font, _size):
        if not text or not text.strip():
            return
        # Text position in page space: the text matrix's origin through the current transformation.
        x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
        y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
        if x == 0 and y == 0 and last:
            # pypdf reports text it joined onto the current line at (0, 0): it continues the previous fragment.
            x, y = last[0] + 1, last[1]
        last[:] = [x, y]
        fx, fy = (x - left) / width, (y - bottom) / height
        if TITLE_BLOCK[0] <= fx <= TITLE_BLOCK[2] and TITLE_BLOCK[1] <= fy <= TITLE_BLOCK[3]:
            fragments.append((x, y, text.strip()))

    try:
        page.extract_text(visitor_text=visit)
    except Exception:
        return ''
    return region_lines(fragments)


def parse_pdf(data: bytes, file_name: str, settings: Settings) -> dict[str, Any]:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted and not reader.decrypt(''):
            raise FileUnreadable('The PDF is password-protected')
        pages = list(reader.pages)
    except FileUnreadable:
        raise
    except (PdfReadError, ValueError, KeyError, TypeError) as exc:
        raise FileUnreadable(f'The PDF could not be read: {type(exc).__name__}') from exc

    out = Collector(settings.max_location_chars)
    if len(pages) > settings.max_units:
        out.warn(f'Only the first {settings.max_units} pages were read')
    texts: list[str] = []
    for page in pages[: settings.max_units]:
        try:
            texts.append(clean(page.extract_text()))
        except Exception:  # one broken content stream must not lose the whole file
            texts.append('')
    blank = [n for n, t in enumerate(texts, start=1) if len(t) < MIN_PAGE_CHARS]

    if blank and docling_available():
        # Scanned or mixed: Docling lays out every page and OCRs the ones without text.
        return parse_with_docling(data, file_name, settings)

    for number, text in enumerate(texts, start=1):
        out.add('page', text, page=number)

    # Drawings: read the title block of the first page (part number, drawing number, revision).
    profile = None
    if pages and texts and len(texts[0]) >= MIN_PAGE_CHARS:
        region = _title_block_region(pages[0])
        fields = title_block(region)
        if fields:
            # bbox in the contract's top-left origin: x 0.5..1, y 0.65..1.
            out.add('region', region, page=1, sectionPath='Title block', bbox=[0.5, 0.65, 1.0, 1.0])
            profile = {'kind': 'drawing', 'titleBlock': {**fields, 'page': 1}}
    if blank:
        shown = ', '.join(map(str, blank[:20])) + (' ...' if len(blank) > 20 else '')
        out.warn(f'{len(blank)} page(s) have no text layer and were not OCRed (pages {shown})')
    return {
        'parser': 'pypdf',
        'unit_count': len(pages),
        'needs_ocr': bool(blank),
        'locations': out.locations,
        'warnings': out.warnings,
        'profile': profile,
    }


def parse_image(data: bytes, file_name: str, settings: Settings) -> dict[str, Any]:
    if docling_available():
        return parse_with_docling(data, file_name, settings)
    return {
        'parser': 'none',
        'unit_count': 1,
        'needs_ocr': True,
        'locations': [],
        'warnings': ['Images need OCR, which is not installed in this docproc build'],
    }
