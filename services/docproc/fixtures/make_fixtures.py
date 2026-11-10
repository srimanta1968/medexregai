"""Build the fictional ingest fixture corpus (no real client data, no real device).

    python services/docproc/fixtures/make_fixtures.py <output-dir>

Writes one file per supported format plus hostile and unsupported cases. Device,
company and numbers are invented ("Fictional Medical Ltd", "Demo Catheter DC-100").
"""

from __future__ import annotations

import csv
import sys
import zipfile
from pathlib import Path

from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches
from pypdf import PdfWriter


def docx(path: Path) -> None:
    doc = Document()
    doc.add_paragraph('Fictional Medical Ltd - Bench test report BT-001 (fixture)')
    doc.add_heading('1 Purpose', level=1)
    doc.add_paragraph('This report records tensile testing of the Demo Catheter DC-100 shaft-to-hub bond.')
    doc.add_heading('5 Results', level=1)
    doc.add_heading('5.2 Tensile', level=2)
    doc.add_paragraph('Mean peak tensile force was 42.0 N (n = 30), above the 15 N acceptance criterion.')
    table = doc.add_table(rows=3, cols=3)
    for r, row in enumerate([('Sample', 'Force (N)', 'Result'), ('S1', '41.2', 'Pass'), ('S2', '43.1', 'Pass')]):
        for c, value in enumerate(row):
            table.cell(r, c).text = value
    doc.add_heading('6 Conclusion', level=1)
    doc.add_paragraph('All samples met the acceptance criterion.')
    doc.save(path / 'bench-report.docx')


def xlsx(path: Path) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = 'Tensile'
    ws.append(['Sample', 'Force (N)', 'Operator', 'Date'])
    ws.append(['S1', 41.2, 'AB', '2026-03-02'])
    ws.append(['S2', 43.1, 'AB', '2026-03-02'])
    ws.append([])
    ws.append(['Mean', '=AVERAGE(B2:B3)'])
    hidden = wb.create_sheet('Calibration')
    hidden.append(['Instrument', 'Due'])
    hidden.append(['Load cell LC-7', '2026-09-30'])
    hidden.sheet_state = 'hidden'
    wb.save(path / 'tensile-raw-data.xlsx')


def pptx(path: Path) -> None:
    deck = Presentation()
    s1 = deck.slides.add_slide(deck.slide_layouts[0])
    s1.shapes.title.text = 'Demo Catheter DC-100 design review'
    s1.placeholders[1].text = 'Fictional Medical Ltd, fixture deck'
    s2 = deck.slides.add_slide(deck.slide_layouts[5])
    s2.shapes.title.text = 'Bond strength summary'
    tbl = s2.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(6), Inches(1)).table
    tbl.cell(0, 0).text, tbl.cell(0, 1).text = 'Test', 'Mean force'
    tbl.cell(1, 0).text, tbl.cell(1, 1).text = 'Shaft-to-hub', '42.0 N'
    s2.notes_slide.notes_text_frame.text = 'Acceptance criterion is 15 N.'
    deck.save(path / 'design-review.pptx')


def _pdf_with_text(pages: list[str]) -> bytes:
    """A minimal valid PDF with one line of Helvetica text per page (byte offsets computed)."""
    objects: list[bytes] = []
    kids = ' '.join(f'{3 + 2 * i} 0 R' for i in range(len(pages)))
    objects.append(b'<< /Type /Catalog /Pages 2 0 R >>')
    objects.append(f'<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>'.encode())
    font_id = 3 + 2 * len(pages)
    for i, text in enumerate(pages):
        content_id = 4 + 2 * i
        objects.append(
            f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font_id} 0 R >> >> /Contents {content_id} 0 R >>'.encode()
        )
        safe = text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')
        stream = f'BT /F1 12 Tf 72 720 Td ({safe}) Tj ET'.encode()
        objects.append(b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream')
    objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    out = bytearray(b'%PDF-1.4\n')
    offsets = []
    for n, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % n + body + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objects) + 1)
    out += b''.join(b'%010d 00000 n \n' % o for o in offsets)
    out += b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objects) + 1, xref)
    return bytes(out)


def pdfs(path: Path) -> None:
    (path / 'test-protocol.pdf').write_bytes(
        _pdf_with_text(['Protocol TP-001: tensile test of the DC-100 shaft-to-hub bond (fixture).', 'Acceptance criterion: peak force of at least 15 N.'])
    )
    # A "scan": a page with no text layer.
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    with open(path / 'scanned-certificate.pdf', 'wb') as fh:
        writer.write(fh)


def other(path: Path) -> None:
    with open(path / 'biocomp-summary.csv', 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['Test', 'Standard', 'Result'])
        w.writerow(['Cytotoxicity', 'ISO 10993-5:2009', 'Pass'])
        w.writerow(['Sensitisation', 'ISO 10993-10:2021', 'Pass'])
    # Hostile: a "Word file" whose one part expands 1000:1.
    with zipfile.ZipFile(path / 'zip-bomb.docx', 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('word/document.xml', b'\0' * (50 * 1024 * 1024))
    # Legacy Word (OLE container header only).
    (path / 'legacy.doc').write_bytes(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + b'\0' * 504)
    (path / 'damaged.pdf').write_bytes(b'%PDF-1.4\n%garbage that is not a pdf body')
    (path / 'notes.bin').write_bytes(bytes(range(256)) * 4)


if __name__ == '__main__':
    out = Path(sys.argv[1] if len(sys.argv) > 1 else 'ingest-fixtures')
    out.mkdir(parents=True, exist_ok=True)
    for build in (docx, xlsx, pptx, pdfs, other):
        build(out)
    print('\n'.join(sorted(p.name for p in out.iterdir())))
