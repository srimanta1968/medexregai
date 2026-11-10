"""docproc HTTP service: POST the bytes of one file, get its passages and locations back.

  GET  /health        liveness (no key): contract version and whether OCR is installed
  GET  /v1/contract   JSON Schema of the parse result
  POST /v1/parse      body = the file's raw bytes (application/octet-stream)
                      X-Docproc-Key: shared secret      X-File-Name: original name (URL-encoded)

Runs in the no-egress sandbox (F7.2): it never fetches anything and keeps nothing.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import os
from urllib.parse import unquote

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from . import errors
from .config import Settings, load_settings
from .contract import CONTRACT_VERSION, ParseResult
from .detect import detect
from .parsers.docling_parser import docling_available
from .runner import run_parse

log = logging.getLogger('docproc')


def _error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({'success': False, 'error': {'code': code, 'message': message}}, status_code=status)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    # Each parse runs in its own process; this bounds how many run at once.
    slots = asyncio.Semaphore(int(os.environ.get('DOCPROC_CONCURRENCY', '') or max(1, (os.cpu_count() or 2) - 1)))
    app = FastAPI(title='MedexRegAI docproc', version=CONTRACT_VERSION, docs_url=None, redoc_url=None)

    @app.get('/health')
    async def health() -> dict:
        return {'status': 'ok', 'contractVersion': CONTRACT_VERSION, 'ocr': docling_available()}

    def authorised(request: Request) -> bool:
        given = request.headers.get('x-docproc-key', '')
        return hmac.compare_digest(given.encode(), settings.api_key.encode())

    @app.get('/v1/contract')
    async def contract(request: Request):
        if not authorised(request):
            return _error(401, 'UNAUTHORIZED', 'A valid X-Docproc-Key header is required')
        return {'success': True, 'data': {'contractVersion': CONTRACT_VERSION, 'schema': ParseResult.model_json_schema(by_alias=True)}}

    @app.post('/v1/parse')
    async def parse(request: Request):
        if not authorised(request):
            return _error(401, 'UNAUTHORIZED', 'A valid X-Docproc-Key header is required')
        declared = request.headers.get('content-length')
        if declared and declared.isdigit() and int(declared) > settings.max_bytes:
            return _error(413, 'FILE_TOO_LARGE', f'Files up to {settings.max_bytes} bytes are accepted')
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > settings.max_bytes:
                return _error(413, 'FILE_TOO_LARGE', f'Files up to {settings.max_bytes} bytes are accepted')
        if not body:
            return _error(400, 'VALIDATION_ERROR', 'The request body must be the file bytes')
        data = bytes(body)
        file_name = unquote(request.headers.get('x-file-name', ''))[:255]
        try:
            found = detect(data, file_name, settings)
            async with slots:
                raw = await run_in_threadpool(run_parse, found.format, data, file_name, settings)
        except errors.DocprocError as exc:
            return _error(exc.status, exc.code, exc.message)
        try:
            result = ParseResult(
                sha256=hashlib.sha256(data).hexdigest(),
                size_bytes=len(data),
                format=found.format,
                mime_type=found.mime_type,
                **raw,
            )
        except ValidationError:
            # A parser produced output that breaks the contract: a bug here, not a bad file.
            log.exception('parser output failed the contract (format=%s)', found.format)
            return _error(500, 'INTERNAL_ERROR', 'The parser produced an invalid result')
        log.info('parsed format=%s parser=%s units=%d locations=%d', result.format, result.parser, result.unit_count, len(result.locations))
        return {'success': True, 'data': result.model_dump(by_alias=True, exclude_none=True)}

    return app
