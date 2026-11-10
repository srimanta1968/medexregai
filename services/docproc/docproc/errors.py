"""Errors with a stable code and HTTP status, rendered as { success:false, error:{ code, message } }."""

from __future__ import annotations


class DocprocError(Exception):
    status = 422
    code = 'FILE_UNREADABLE'

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class FileTooLarge(DocprocError):
    status = 413
    code = 'FILE_TOO_LARGE'


class UnsupportedFormat(DocprocError):
    status = 415
    code = 'UNSUPPORTED_FORMAT'


class FileUnreadable(DocprocError):
    status = 422
    code = 'FILE_UNREADABLE'


class ArchiveLimit(DocprocError):
    """Zip bomb or too many parts: refused before any parser opens the file."""

    status = 422
    code = 'ARCHIVE_LIMIT'


class ParseTimeout(DocprocError):
    status = 504
    code = 'PARSE_TIMEOUT'
