"""Throttled progress logs — tránh spam khi loop hàng trăm/nghìn lần."""

from __future__ import annotations

import logging


def progress(
    logger: logging.Logger,
    label: str,
    index: int,
    total: int,
    *,
    every: int = 10,
    level: int = logging.INFO,
) -> None:
    """Log `label i/total` at first, last, and every `every` ticks (1-based index)."""
    if total <= 0:
        return
    i = index + 1
    if i == 1 or i == total or (every > 0 and i % every == 0):
        logger.log(level, "%s %d/%d", label, i, total)
