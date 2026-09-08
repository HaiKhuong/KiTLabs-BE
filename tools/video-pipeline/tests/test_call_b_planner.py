"""CallB picks must never emit empty per-segment rows."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "recap"))

from call_b_shot_planner import (  # noqa: E402
    PICKS_SELECTED_SHOTS,
    _overlaps_window,
    plan_all_segments,
    sanitize_picks,
)


def _shots(n: int, dur: float = 2.0) -> list[dict]:
    out = []
    t = 0.0
    for i in range(1, n + 1):
        out.append(
            {
                "id": i,
                "startSec": t,
                "endSec": t + dur,
                "durationSec": dur,
                "sceneGroupId": (i - 1) // 4,
            }
        )
        t += dur
    return out


class TestCallBNoEmptyPicks(unittest.TestCase):
    def test_sanitize_fills_empty_rows_from_shots(self) -> None:
        shots = _shots(12)
        raw = [[1, 2], [], [5], []]
        narrations = ["a", "b", "c", "d"]
        tts = [{"durationSec": 6.0} for _ in narrations]
        fixed = sanitize_picks(
            raw,
            segment_candidates=[[] for _ in narrations],
            tts_meta=tts,
            narrations=narrations,
            shots=shots,
        )
        self.assertEqual(len(fixed), 4)
        self.assertTrue(all(len(row) > 0 for row in fixed))

    def test_sanitize_pads_missing_segments_without_empty(self) -> None:
        shots = _shots(20)
        narrations = ["a", "b", "c"]
        tts = [{"durationSec": 8.0} for _ in narrations]
        fixed = sanitize_picks(
            [[1, 2]],
            segment_candidates=[[], [], []],
            tts_meta=tts,
            narrations=narrations,
            shots=shots,
        )
        self.assertEqual(len(fixed), 3)
        self.assertTrue(all(len(row) > 0 for row in fixed))

    def test_reuse_skips_shots_near_current_cursor(self) -> None:
        shots = _shots(14)
        raw = [[1], [2, 3, 4, 5], [7, 8], [13, 14], []]
        narrations = ["a", "b", "c", "d", "e"]
        tts = [{"durationSec": 4.0} for _ in narrations]
        fixed = sanitize_picks(
            raw,
            segment_candidates=[[] for _ in narrations],
            tts_meta=tts,
            narrations=narrations,
            shots=shots,
        )
        self.assertEqual(len(fixed), 5)
        self.assertTrue(fixed[-1])
        recent = {7, 8, 13, 14}
        self.assertTrue(recent.isdisjoint(fixed[-1]), msg=f"reused too-recent shots: {fixed[-1]}")

    def test_sanitize_reuses_when_all_shots_already_used(self) -> None:
        shots = _shots(3)
        narrations = ["a", "b", "c", "d", "e"]
        tts = [{"durationSec": 4.0} for _ in narrations]
        raw = [[1], [2], [3], [], []]
        fixed = sanitize_picks(
            raw,
            segment_candidates=[[] for _ in narrations],
            tts_meta=tts,
            narrations=narrations,
            shots=shots,
        )
        self.assertEqual(len(fixed), 5)
        self.assertTrue(all(len(row) > 0 for row in fixed))

    def test_plan_all_segments_never_empty_rows(self) -> None:
        shots = _shots(30)
        segments = [{"narration": f"n{i}", "visualBeats": [], "eventIds": []} for i in range(8)]
        tts = [{"durationSec": 10.0} for _ in segments]
        out = plan_all_segments(
            segments,
            segment_candidates=[[] for _ in segments],
            tts_meta=tts,
            shots=shots,
            semantic={},
            work_dir=None,
            cfg={"ranking": {"openingSegments": 2, "endingSegments": 2}},
            knowledge={},
        )
        rows = out[PICKS_SELECTED_SHOTS]
        self.assertEqual(len(rows), 8)
        self.assertTrue(all(isinstance(row, list) and len(row) > 0 for row in rows))

    def test_empty_fill_uses_movie_source_window(self) -> None:
        shots = _shots(20, dur=2.0)
        narrations = ["open", "mid", "end"]
        tts = [{"durationSec": 6.0} for _ in narrations]
        windows = [[0.0, 8.0], [20.0, 28.0], [32.0, 40.0]]
        fixed = sanitize_picks(
            [[], [], []],
            segment_candidates=[[] for _ in narrations],
            tts_meta=tts,
            narrations=narrations,
            shots=shots,
            movie_windows=windows,
        )
        self.assertEqual(len(fixed), 3)
        by_id = {int(s["id"]): s for s in shots}
        for row, (t0, t1) in zip(fixed, windows, strict=True):
            self.assertTrue(row)
            for sid in row:
                self.assertTrue(_overlaps_window(by_id[sid], t0, t1, slack=8.0), msg=f"shot {sid} outside {t0}-{t1}")

    def test_plan_picks_stay_in_segment_windows(self) -> None:
        shots = _shots(24, dur=2.0)
        segments = [{"narration": f"n{i}", "visualBeats": [], "eventIds": []} for i in range(3)]
        windows = [[0.0, 10.0], [18.0, 28.0], [36.0, 48.0]]
        tts = [{"durationSec": 8.0} for _ in segments]
        out = plan_all_segments(
            segments,
            segment_candidates=[[] for _ in segments],
            tts_meta=tts,
            shots=shots,
            semantic={},
            work_dir=None,
            cfg={"ranking": {"openingSegments": 1, "endingSegments": 1}},
            knowledge={},
            movie_windows=windows,
        )
        rows = out[PICKS_SELECTED_SHOTS]
        by_id = {int(s["id"]): s for s in shots}
        for row, (t0, t1) in zip(rows, windows, strict=True):
            self.assertTrue(row)
            for sid in row:
                self.assertTrue(
                    _overlaps_window(by_id[sid], t0, t1, slack=20.0),
                    msg=f"shot {sid} outside window {t0}-{t1}",
                )


if __name__ == "__main__":
    unittest.main()
