"""Shared helpers: build locations in reading order and keep their text within limits."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Optional

_SPACE = re.compile(r'[ \t ]+')
_BLANK_LINES = re.compile(r'\n{3,}')


def clean(text: Optional[str]) -> str:
    if not text:
        return ''
    text = text.replace('\r\n', '\n').replace('\r', '\n').replace('\x00', '')
    text = '\n'.join(_SPACE.sub(' ', line).strip() for line in text.split('\n'))
    return _BLANK_LINES.sub('\n\n', text).strip()


@dataclass
class Collector:
    """Accumulates locations; splits text that is too long so no passage is silently cut."""

    max_chars: int
    locations: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def add(self, kind: str, text: str, **where: Any) -> None:
        text = clean(text)
        if not text:
            return
        where = {k: v for k, v in where.items() if v is not None}
        while text:
            part, text = text[: self.max_chars], text[self.max_chars :]
            self.locations.append({'ordinal': len(self.locations), 'kind': kind, 'text': part, **where})

    def warn(self, message: str) -> None:
        if message not in self.warnings and len(self.warnings) < 50:
            self.warnings.append(message)


def section_path(stack: list[str]) -> Optional[str]:
    path = ' > '.join(stack)
    return path[:500] if path else None
