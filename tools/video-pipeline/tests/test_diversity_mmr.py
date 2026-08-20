"""Regression: mmr_select must return only new picks when selected_seed is set."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "recap"))

from diversity import mmr_select  # noqa: E402


def _shot(sid: int, score: float = 1.0) -> dict:
    return {
        "id": sid,
        "shot_id": sid,
        "startSec": float(sid * 10),
        "endSec": float(sid * 10 + 5),
        "durationSec": 5.0,
        "score": score,
    }


def test_mmr_select_with_seed_returns_only_new_items():
    seed = [_shot(1), _shot(2)]
    pool = [_shot(3, 0.9), _shot(4, 0.8), _shot(5, 0.7)]
    extra = mmr_select(pool, relevance={3: 0.9, 4: 0.8, 5: 0.7}, embeddings=None, k=1, selected_seed=seed)
    assert len(extra) == 1
    assert extra[0]["id"] not in {1, 2}


def test_mmr_select_k_greater_than_pool():
    seed = [_shot(1)]
    pool = [_shot(2), _shot(3)]
    extra = mmr_select(pool, relevance={2: 1.0, 3: 0.5}, embeddings=None, k=2, selected_seed=seed)
    assert len(extra) == 2
    assert {e["id"] for e in extra} == {2, 3}
