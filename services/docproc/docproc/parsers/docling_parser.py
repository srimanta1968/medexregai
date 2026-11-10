"""Docling: layout analysis and OCR for scanned PDFs and images (optional dependency).

Installed only in the full image (requirements-docling.txt). Its layout and OCR models
must be baked into that image: the sandbox has no network, so nothing may download at
run time (set DOCLING_ARTIFACTS_PATH to the baked model folder).
"""

from __future__ import annotations

import importlib.util
import io
import os
from typing import Any, Optional

from ..config import Settings
from ..errors import FileUnreadable
from .common import Collector, section_path


def docling_available() -> bool:
    if os.environ.get('DOCPROC_DISABLE_DOCLING') == '1':
        return False
    return importlib.util.find_spec('docling') is not None


def _bbox(item_prov: Any, doc: Any) -> Optional[list[float]]:
    """Docling boxes are in page points; the contract wants 0..1 with a top-left origin."""
    try:
        page = doc.pages[item_prov.page_no]
        width, height = page.size.width, page.size.height
        box = item_prov.bbox.to_top_left_origin(page_height=height)
        return [round(box.l / width, 4), round(box.t / height, 4), round(box.r / width, 4), round(box.b / height, 4)]
    except Exception:
        return None


def parse_with_docling(data: bytes, file_name: str, settings: Settings) -> dict[str, Any]:
    from docling.datamodel.base_models import DocumentStream, InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption
    from docling_core.types.doc import SectionHeaderItem, TableItem, TextItem, TitleItem

    artifacts = os.environ.get('DOCLING_ARTIFACTS_PATH')
    options = PdfPipelineOptions(artifacts_path=artifacts) if artifacts else PdfPipelineOptions()
    options.do_ocr = True
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=options),
            InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
        }
    )
    try:
        result = converter.convert(DocumentStream(name=file_name or 'upload', stream=io.BytesIO(data)), max_num_pages=settings.max_units)
    except Exception as exc:
        raise FileUnreadable(f'The file could not be laid out: {type(exc).__name__}') from exc
    doc = result.document

    out = Collector(settings.max_location_chars)
    stack: list[str] = []
    for item, _level in doc.iterate_items():
        prov = item.prov[0] if getattr(item, 'prov', None) else None
        page = prov.page_no if prov else None
        if page is None:
            continue
        bbox = _bbox(prov, doc)
        if isinstance(item, (TitleItem, SectionHeaderItem)):
            depth = getattr(item, 'level', 1) if isinstance(item, SectionHeaderItem) else 0
            del stack[max(depth - 1, 0) :]
            stack.append(' '.join(item.text.split()))
            out.add('paragraph', item.text, page=page, sectionPath=section_path(stack), bbox=bbox)
        elif isinstance(item, TableItem):
            out.add('table', item.export_to_markdown(doc=doc), page=page, sectionPath=section_path(stack), bbox=bbox)
        elif isinstance(item, TextItem):
            out.add('paragraph', item.text, page=page, sectionPath=section_path(stack), bbox=bbox)
    return {
        'parser': 'docling',
        'unit_count': len(doc.pages),
        'ocr_used': True,
        'locations': out.locations,
        'warnings': out.warnings,
    }
