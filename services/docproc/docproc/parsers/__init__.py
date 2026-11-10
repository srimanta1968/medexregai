"""Pick the parser for a detected format."""

from __future__ import annotations

from typing import Any

from ..config import Settings
from .ooxml import parse_docx, parse_pptx, parse_xlsx
from .pdf import parse_image, parse_pdf
from .text import parse_csv


def parse(fmt: str, data: bytes, file_name: str, settings: Settings) -> dict[str, Any]:
    if fmt == 'docx':
        return parse_docx(data, settings)
    if fmt == 'xlsx':
        return parse_xlsx(data, settings)
    if fmt == 'pptx':
        return parse_pptx(data, settings)
    if fmt == 'pdf':
        return parse_pdf(data, file_name, settings)
    if fmt == 'image':
        return parse_image(data, file_name, settings)
    if fmt == 'csv':
        return parse_csv(data, file_name, settings)
    raise ValueError(f'no parser for {fmt}')
