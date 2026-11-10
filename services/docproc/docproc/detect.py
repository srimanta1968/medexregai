"""Decide the format from the bytes, never from the file name alone, and vet zip containers."""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass

from .config import Settings
from .errors import ArchiveLimit, FileUnreadable, UnsupportedFormat

MIME = {
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'pdf': 'application/pdf',
    'csv': 'text/csv',
}
IMAGE_MIME = {b'\x89PNG\r\n\x1a\n': 'image/png', b'\xff\xd8\xff': 'image/jpeg', b'II*\x00': 'image/tiff', b'MM\x00*': 'image/tiff'}
OLE_MAGIC = b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'
TEXT_EXTENSIONS = ('.csv', '.tsv', '.txt')


@dataclass(frozen=True)
class Detected:
    format: str
    mime_type: str


def check_zip(data: bytes, settings: Settings) -> zipfile.ZipFile:
    """Open a zip only after checking entry count, total size and compression ratio."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise FileUnreadable('The file is a damaged zip container') from exc
    infos = archive.infolist()
    if len(infos) > settings.max_zip_entries:
        raise ArchiveLimit(f'The file has {len(infos)} parts; the limit is {settings.max_zip_entries}')
    total = sum(i.file_size for i in infos)
    if total > settings.max_zip_uncompressed:
        raise ArchiveLimit(f'The file expands to {total} bytes; the limit is {settings.max_zip_uncompressed}')
    for info in infos:
        if info.compress_size and info.file_size / info.compress_size > settings.max_zip_ratio:
            raise ArchiveLimit(f'Part {info.filename!r} is compressed {info.file_size // info.compress_size}:1, a likely zip bomb')
        if info.flag_bits & 0x1:
            raise FileUnreadable('The file is password-protected')
    return archive


def detect(data: bytes, file_name: str, settings: Settings) -> Detected:
    head = data[:16]
    if head.startswith(b'%PDF-'):
        return Detected('pdf', MIME['pdf'])
    for magic, mime in IMAGE_MIME.items():
        if head.startswith(magic):
            return Detected('image', mime)
    if head.startswith(OLE_MAGIC):
        # .doc/.xls/.ppt, or an Office file encrypted with a password (also stored as OLE).
        raise UnsupportedFormat('Legacy Office (.doc, .xls, .ppt) or password-protected Office file: save it as .docx, .xlsx or .pptx')
    if head.startswith(b'PK\x03\x04'):
        names = set(check_zip(data, settings).namelist())
        if 'word/document.xml' in names:
            return Detected('docx', MIME['docx'])
        if 'xl/workbook.xml' in names:
            return Detected('xlsx', MIME['xlsx'])
        if 'ppt/presentation.xml' in names:
            return Detected('pptx', MIME['pptx'])
        raise UnsupportedFormat('Zip archives are not parsed directly; unpack them so each file is read on its own')
    if file_name.lower().endswith(TEXT_EXTENSIONS) and b'\x00' not in data[:8192]:
        return Detected('csv', MIME['csv'])
    raise UnsupportedFormat('This file type is not supported. Supported: DOCX, XLSX, PPTX, PDF, PNG, JPEG, TIFF, CSV')
