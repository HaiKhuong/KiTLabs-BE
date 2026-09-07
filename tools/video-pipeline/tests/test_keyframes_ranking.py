"""Adaptive keyframe picker + quality metrics."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "recap"))

from keyframes import (  # noqa: E402
    probe_timestamps,
    quality_shot_from_probes,
    score_gray_array,
    select_primary_secondary,
)
from ranking import a2_length_quota, duration_out_of_range, final_score, temporal_score  # noqa: E402

try:
    import numpy as np

    HAS_NP = True
except Exception:
    HAS_NP = False


class TestKeyframeSelection(unittest.TestCase):
    def test_short_shot_one_probe(self) -> None:
        ts = probe_timestamps(10.0, 11.2)
        self.assertEqual(len(ts), 1)
        self.assertGreater(ts[0], 10.0)
        self.assertLess(ts[0], 11.2)

    def test_long_shot_three_probes(self) -> None:
        ts = probe_timestamps(0.0, 8.0)
        self.assertEqual(len(ts), 3)
        self.assertAlmostEqual(ts[0], 1.2, places=2)
        self.assertAlmostEqual(ts[1], 4.0, places=2)

    @unittest.skipUnless(HAS_NP, "numpy not installed")
    def test_blurry_frame_scores_higher_blur(self) -> None:
        sharp = np.zeros((40, 40), dtype=np.uint8)
        sharp[:, ::2] = 255
        blurry = np.full((40, 40), 120, dtype=np.uint8)
        s_sharp = score_gray_array(sharp, t=1.0, start_sec=0.0, end_sec=4.0)
        s_blur = score_gray_array(blurry, t=1.0, start_sec=0.0, end_sec=4.0)
        self.assertLess(s_sharp["blur"], s_blur["blur"])

    @unittest.skipUnless(HAS_NP, "numpy not installed")
    def test_transition_risk_near_cut(self) -> None:
        img = np.full((20, 20), 128, dtype=np.uint8)
        edge = score_gray_array(img, t=0.02, start_sec=0.0, end_sec=5.0)
        mid = score_gray_array(img, t=2.5, start_sec=0.0, end_sec=5.0)
        self.assertGreater(edge["transitionRisk"], mid["transitionRisk"])

    def test_secondary_only_when_motion_and_long(self) -> None:
        def probe(t: float, conf: float, motion: float) -> dict:
            return {"t": t, "path": f"{t}.jpg", "metrics": {"confidence": conf, "motion": motion}}

        probes = [probe(1.0, 0.8, 0.05), probe(3.0, 0.7, 0.4)]
        primary, secondary = select_primary_secondary(probes, duration_sec=5.0, motion_threshold=0.22)
        self.assertIsNotNone(primary)
        self.assertEqual(len(secondary), 1)

        primary2, secondary2 = select_primary_secondary(
            [probe(1.0, 0.9, 0.05), probe(3.0, 0.8, 0.05)],
            duration_sec=5.0,
            motion_threshold=0.22,
        )
        self.assertEqual(len(secondary2), 0)
        self.assertGreater(float(primary2["metrics"]["confidence"]), 0.8)

        _, none_sec = select_primary_secondary(probes, duration_sec=2.0, motion_threshold=0.22)
        self.assertEqual(none_sec, [])

    def test_quality_aggregates_visual_change(self) -> None:
        probes = [
            {"metrics": {"blur": 0.1, "brightness": 0.5, "contrast": 0.4, "motion": 0.1, "transitionRisk": 0.0, "confidence": 0.7}},
            {"metrics": {"blur": 0.2, "brightness": 0.5, "contrast": 0.4, "motion": 0.5, "transitionRisk": 0.0, "confidence": 0.6}},
        ]
        q = quality_shot_from_probes(probes)
        self.assertAlmostEqual(q["visualChange"], 0.5, places=3)
        self.assertNotIn("confidence", q)


class TestRanking(unittest.TestCase):
    def test_temporal_decay(self) -> None:
        near = temporal_score(100.0, 102.0, decay_sec=25.0)
        far = temporal_score(100.0, 160.0, decay_sec=25.0)
        self.assertGreater(near, far)
        self.assertGreater(near, 0.8)
        self.assertLess(far, 0.15)

    def test_character_weight_zero_by_default(self) -> None:
        a = final_score(clip_sim=0.9, temporal=0.8, quality=0.7, scene=0.5, character=1.0)
        b = final_score(clip_sim=0.9, temporal=0.8, quality=0.7, scene=0.5, character=0.0)
        self.assertAlmostEqual(a, b)

    def test_a2_quota_15_20_min(self) -> None:
        q = a2_length_quota(900, 1200, wpm=140)
        self.assertEqual(q["targetMidSec"], 1050)
        self.assertGreaterEqual(q["targetSegmentCount"], 32)
        self.assertLessEqual(q["targetSegmentCount"], 48)
        self.assertTrue(duration_out_of_range(573.0, 900, 1200))
        self.assertFalse(duration_out_of_range(1050.0, 900, 1200))


if __name__ == "__main__":
    unittest.main()
