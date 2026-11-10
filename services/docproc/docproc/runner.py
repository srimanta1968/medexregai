"""Run one parse in a child process that is killed when it runs past the time limit.

A hostile or pathological file (deeply nested tables, a PDF with a huge content stream)
can hang a parser library; killing the child is the only reliable stop. The container's
CPU and memory limits (sandbox task) bound what the child can use while it runs.
"""

from __future__ import annotations

import multiprocessing as mp
import queue
import time
from typing import Any

from . import errors
from .config import Settings

_CTX = mp.get_context('spawn')


def _child(out: Any, fmt: str, data: bytes, file_name: str, settings: Settings) -> None:
    from .parsers import parse

    try:
        out.put(('ok', parse(fmt, data, file_name, settings)))
    except errors.DocprocError as exc:
        out.put(('error', type(exc).__name__, exc.message))
    except MemoryError:
        out.put(('error', 'FileUnreadable', 'The file needs more memory than the parser is allowed'))
    except Exception as exc:  # parser library bug on a malformed file
        out.put(('error', 'FileUnreadable', f'The file could not be parsed: {type(exc).__name__}'))


def run_parse(fmt: str, data: bytes, file_name: str, settings: Settings) -> dict[str, Any]:
    out = _CTX.Queue(maxsize=1)
    proc = _CTX.Process(target=_child, args=(out, fmt, data, file_name, settings), daemon=True)
    proc.start()
    deadline = time.monotonic() + settings.parse_timeout_s
    message = None
    try:
        # Read before join: a large result blocks the child until the queue is drained.
        while message is None:
            try:
                message = out.get(timeout=0.25)
            except queue.Empty:
                if not proc.is_alive():
                    # Died without answering: killed for memory, or the interpreter crashed.
                    raise errors.FileUnreadable('The parser stopped without a result (out of memory or crashed)')
                if time.monotonic() > deadline:
                    raise errors.ParseTimeout(f'Parsing took longer than {settings.parse_timeout_s} s and was stopped')
    finally:
        if proc.is_alive() and message is None:
            proc.kill()
        proc.join(5)
        out.close()
    if message[0] == 'ok':
        return message[1]
    cls = getattr(errors, message[1], errors.FileUnreadable)
    raise cls(message[2])
