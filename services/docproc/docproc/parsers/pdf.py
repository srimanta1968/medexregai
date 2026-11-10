"""PDF: pypdf for the text layer, page by page. Pages without one need OCR (Docling build)."""

from __future__ import annotations

import io
from typing import Any

from ..config import Settings
from ..errors import FileUnreadable
from .common import Collector, clean
from .docling_parser import docling_available, parse_with_docling

# A page with fewer characters than this has no usable text layer (a scan, or only images).
MIN_PAGE_CHARS = 20


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
    if blank:
        shown = ', '.join(map(str, blank[:20])) + (' ...' if len(blank) > 20 else '')
        out.warn(f'{len(blank)} page(s) have no text layer and were not OCRed (pages {shown})')
    return {
        'parser': 'pypdf',
        'unit_count': len(pages),
        'needs_ocr': bool(blank),
        'locations': out.locations,
        'warnings': out.warnings,
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
