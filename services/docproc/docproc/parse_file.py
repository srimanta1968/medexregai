"""Parse one local file and print the docproc/1 response body (as POST /v1/parse returns it), without the HTTP server.

    python -m docproc.parse_file <path>

Same detection, limits and killed-on-timeout child process as the service; used by
the prompt-injection suite in CI (server/src/ai/guard/injectionSuite.ts) and for
debugging a file. No network, no API key needed (nothing is served).
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

from .config import load_settings
from .contract import ParseResult
from .detect import detect
from .errors import DocprocError
from .runner import run_parse


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print('usage: python -m docproc.parse_file <path>', file=sys.stderr)
        return 2
    # Nothing is served, so the key only satisfies the settings loader.
    os.environ.setdefault('DOCPROC_API_KEY', 'local-cli-no-server-000000')
    settings = load_settings()
    path = Path(argv[1])
    data = path.read_bytes()
    try:
        found = detect(data, path.name, settings)
        result = run_parse(found.format, data, path.name, settings)
    except DocprocError as err:
        print(json.dumps({'success': False, 'error': {'code': err.code, 'message': err.message}}))
        return 1
    # Exactly the service's response body: the same contract model, the same aliases.
    parsed = ParseResult(sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data), format=found.format, mime_type=found.mime_type, **result)
    print(json.dumps({'success': True, 'data': parsed.model_dump(by_alias=True, exclude_none=True)}, ensure_ascii=True))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
