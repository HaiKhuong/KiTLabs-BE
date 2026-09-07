"""Candidate expansion + scene grouping + MMR consecutive penalty + A2 quota."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "recap"))

from call_a2_script_writer import build_a2_payload, heuristic_segments  # noqa: E402
from cluster import adjacent_should_merge, shortlist_shots  # noqa: E402
from diversity import mmr_select  # noqa: E402
from qwen_vl import attach_visual_evidence, collect_vlm_targets, knowledge_has_vlm  # noqa: E402


def _shots(n: int = 8) -> list[dict]:
    out = []
    for i in range(n):
        gid = 0 if i < 4 else 1
        out.append(
            {
                "id": i,
                "startSec": float(i * 3),
                "endSec": float(i * 3 + 2.5),
                "sceneGroupId": gid,
            }
        )
    return out


def _semantic(shots: list[dict]) -> dict:
    shot_to_scene = {}
    shot_to_group = {}
    for s in shots:
        gid = int(s["sceneGroupId"])
        shot_to_scene[str(s["id"])] = f"ss_{gid:04d}"
        shot_to_group[str(s["id"])] = gid
    return {"shotToScene": shot_to_scene, "shotToGroup": shot_to_group, "scenes": []}


class TestSceneGrouping(unittest.TestCase):
    def test_merge_requires_clip_gap_and_subtitle_or_short(self) -> None:
        self.assertTrue(
            adjacent_should_merge(
                clip_sim=0.9,
                sim_threshold=0.82,
                time_gap=0.4,
                subtitle_jaccard=0.4,
                prev_duration_sec=4.0,
            )
        )
        self.assertFalse(
            adjacent_should_merge(
                clip_sim=0.95,
                sim_threshold=0.82,
                time_gap=8.0,
                subtitle_jaccard=0.9,
                prev_duration_sec=4.0,
            )
        )
        self.assertFalse(
            adjacent_should_merge(
                clip_sim=0.9,
                sim_threshold=0.82,
                time_gap=0.2,
                subtitle_jaccard=0.0,
                prev_duration_sec=5.0,
                next_duration_sec=4.0,
            )
        )
        self.assertTrue(
            adjacent_should_merge(
                clip_sim=0.9,
                sim_threshold=0.82,
                time_gap=0.2,
                subtitle_jaccard=0.0,
                prev_duration_sec=1.2,
                next_duration_sec=4.0,
            )
        )


class TestCandidateExpansion(unittest.TestCase):
    def test_shortlist_keeps_window_primary_and_neighbors(self) -> None:
        shots = _shots()
        semantic = _semantic(shots)
        cands = shortlist_shots(
            shots,
            semantic,
            movie_range=(3.0, 6.0),
            need_sec=5.0,
            pad=0.2,
            neighbor_k=2,
            expand_pad=30.0,
            limit=20,
        )
        ids = {c["id"] for c in cands}
        self.assertTrue(1 in ids or 2 in ids)
        self.assertTrue(any(c.get("source") == "secondary" for c in cands) or len(ids) > 2)


class TestMmrConsecutive(unittest.TestCase):
    def test_mmr_soft_penalizes_consecutive_ids(self) -> None:
        seed = [{"id": 10, "shot_id": 10, "startSec": 100.0, "endSec": 105.0, "durationSec": 5.0}]
        pool = [
            {"id": 11, "shot_id": 11, "startSec": 105.0, "endSec": 110.0, "durationSec": 5.0, "score": 0.9},
            {"id": 40, "shot_id": 40, "startSec": 400.0, "endSec": 405.0, "durationSec": 5.0, "score": 0.88},
        ]
        extra = mmr_select(
            pool,
            relevance={11: 0.9, 40: 0.88},
            embeddings=None,
            k=1,
            selected_seed=seed,
            consecutive_penalty=0.5,
        )
        self.assertEqual(extra[0]["id"], 40)


class TestA2Quota(unittest.TestCase):
    def test_a2_payload_and_heuristic_quota(self) -> None:
        knowledge = {
            "movieTitle": "T",
            "movieSummary": "A hero saves the town.",
            "events": [
                {
                    "eventId": "EV_001",
                    "title": "Start",
                    "summary": "Hero arrives.",
                    "importance": 7,
                    "emotion": "calm",
                    "window": {"from": 0, "to": 30},
                }
            ],
            "plotFacts": ["Hero arrives."],
        }
        payload = build_a2_payload(knowledge, locale="vi", dur_min=900, dur_max=1200, wpm=140)
        self.assertEqual(payload["targetMidSec"], 1050)
        self.assertGreaterEqual(payload["targetSegmentCount"], 32)
        self.assertEqual(payload["events"][0].get("visualEvidence"), "")
        knowledge["events"][0]["visualEvidence"] = "Hai người đứng trước cửa hàng."
        payload2 = build_a2_payload(knowledge, locale="vi", dur_min=900, dur_max=1200, wpm=140)
        self.assertIn("cửa hàng", payload2["events"][0]["visualEvidence"])
        segs = heuristic_segments(knowledge, locale="vi", dur_min=900, dur_max=1200, wpm=140)
        self.assertEqual(len(segs), payload["targetSegmentCount"])
        self.assertGreaterEqual(len(segs[0]["narration"].split()), payload["wordsPerSegmentRange"][0])


class TestVlmShortlist(unittest.TestCase):
    def test_collect_caps_and_requires_existing_jpg(self) -> None:
        import tempfile

        td = Path(tempfile.mkdtemp())
        kf = td / "keyframes"
        kf.mkdir()
        (kf / "shot_00001.jpg").write_bytes(b"x")
        (kf / "shot_00002.jpg").write_bytes(b"x")
        knowledge = {
            "events": [
                {
                    "eventId": "EV_001",
                    "title": "Fight",
                    "summary": "People fight",
                    "candidate_shots": [
                        {"shot_id": 1, "score": 0.9},
                        {"shot_id": 2, "score": 0.8},
                        {"shot_id": 3, "score": 0.7},
                    ],
                }
            ]
        }
        shots = [{"id": i, "startSec": i, "endSec": i + 1} for i in range(1, 4)]
        jobs = collect_vlm_targets(knowledge, shots=shots, keyframes_dir=kf, max_shots_per_event=2)
        self.assertEqual(len(jobs), 1)
        self.assertEqual([f["shot_id"] for f in jobs[0]["frames"]], [1, 2])
        captions = {"EV_001": "Hai người đánh nhau."}
        attach_visual_evidence(knowledge, captions, jobs)
        self.assertTrue(knowledge_has_vlm(knowledge))
        self.assertIn("đánh", knowledge["events"][0]["visualEvidence"])


if __name__ == "__main__":
    unittest.main()
