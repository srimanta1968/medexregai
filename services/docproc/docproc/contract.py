"""The docproc JSON contract (version docproc/1).

The worker sends a file's bytes; docproc answers with where every passage sits.
Locations map 1:1 onto the app's source_locations table (server migration 015):

  kind       where it sits                         required fields
  page       a PDF / scanned page                  page
  paragraph  running text                          page | slide | sheet | sectionPath
  table      a table, rows as lines                page | slide | sheet | sectionPath
  cell       a spreadsheet row range               sheet + cellRange
  slide      a whole slide (text, tables, notes)   slide
  region     an area of a page (title block)       page (+ bbox)

The service is stateless and never fetches anything: no URLs in, no network out.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

CONTRACT_VERSION = 'docproc/1'

Format = Literal['docx', 'xlsx', 'pptx', 'pdf', 'image', 'csv']
LocationKind = Literal['page', 'paragraph', 'table', 'cell', 'slide', 'region']


def _camel(name: str) -> str:
    head, *rest = name.split('_')
    return head + ''.join(part.title() for part in rest)


class _Model(BaseModel):
    model_config = ConfigDict(alias_generator=_camel, populate_by_name=True, extra='forbid')


class Location(_Model):
    ordinal: int = Field(ge=0, description='Reading order within the file, from 0')
    kind: LocationKind
    page: Optional[int] = Field(default=None, ge=1)
    sheet: Optional[str] = Field(default=None, max_length=100)
    cell_range: Optional[str] = Field(default=None, max_length=40, description='e.g. "B5:F5"')
    slide: Optional[int] = Field(default=None, ge=1)
    section_path: Optional[str] = Field(default=None, max_length=500, description='Heading path, e.g. "5 Results > 5.2 Tensile"')
    bbox: Optional[list[float]] = Field(default=None, min_length=4, max_length=4, description='[x0, y0, x1, y1] in 0..1 page coordinates')
    text: str

    @model_validator(mode='after')
    def _has_place(self) -> 'Location':
        ok = {
            'cell': self.sheet is not None and self.cell_range is not None,
            'slide': self.slide is not None,
            'page': self.page is not None,
            'region': self.page is not None,
        }.get(self.kind, any(v is not None for v in (self.page, self.slide, self.sheet, self.section_path)))
        if not ok:
            raise ValueError(f'{self.kind} location {self.ordinal} does not say where it is')
        return self


class ParseResult(_Model):
    contract_version: str = CONTRACT_VERSION
    sha256: str = Field(pattern=r'^[0-9a-f]{64}$')
    size_bytes: int = Field(ge=0)
    format: Format
    mime_type: str
    parser: str = Field(description='Which engine read the file, e.g. "python-docx", "pypdf", "docling"')
    unit_count: int = Field(ge=0, description='Pages (PDF, image), slides (PPTX), sheets (XLSX); 1 for DOCX and CSV')
    ocr_used: bool = False
    needs_ocr: bool = Field(default=False, description='Pages without a text layer that were not OCRed (OCR engine not installed)')
    locations: list[Location]
    warnings: list[str] = Field(default_factory=list)
    profile: Optional[dict[str, Any]] = Field(
        default=None,
        description='raw_data: per-sheet columns, units, types and ranges; drawing: title-block fields (partNumber, drawingNumber, revision, title)',
    )


class ErrorBody(_Model):
    code: str
    message: str


class ErrorEnvelope(_Model):
    success: Literal[False] = False
    error: ErrorBody


class ParseEnvelope(_Model):
    success: Literal[True] = True
    data: ParseResult
