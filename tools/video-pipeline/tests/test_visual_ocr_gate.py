"""Unit tests for OpenCV subtitle gate helpers."""

from __future__ import annotations

import numpy as np
import pytest

from subtitle.visual_ocr_gate import (
    mask_ink_change_ratio,
    mask_iou,
    merge_cue_shells_by_mask,
    resolve_opencv_change_threshold,
)


def _ink_mask(y0: int, y1: int, x0: int, x1: int, h: int = 40, w: int = 200) -> np.ndarray:
    mask = np.zeros((h, w), dtype=np.uint8)
    mask[y0:y1, x0:x1] = 255
    return mask


def test_mask_iou_identical():
    a = _ink_mask(30, 38, 20, 180)
    assert mask_iou(a, a) == pytest.approx(1.0)


def test_mask_iou_disjoint():
    a = _ink_mask(30, 38, 10, 80)
    b = _ink_mask(30, 38, 120, 190)
    assert mask_iou(a, b) == pytest.approx(0.0)


def test_mask_ink_change_ratio_small_jitter():
    a = _ink_mask(30, 38, 20, 180)
    b = _ink_mask(29, 37, 21, 181)
    ratio = mask_ink_change_ratio(a, b)
    assert ratio < 0.15


def test_mask_ink_change_ratio_new_text():
    a = _ink_mask(30, 38, 10, 90)
    b = _ink_mask(30, 38, 110, 190)
    ratio = mask_ink_change_ratio(a, b)
    assert ratio > 0.5


def test_resolve_opencv_change_threshold_prefers_ink():
    thr, metric = resolve_opencv_change_threshold(8.0, 0.15)
    assert metric == "ink_ratio"
    assert thr == pytest.approx(0.15)


def test_resolve_opencv_change_threshold_mad_fallback():
    thr, metric = resolve_opencv_change_threshold(8.0, 0.0)
    assert metric == "mad"
    assert thr == pytest.approx(8.0)


def test_merge_cue_shells_by_mask(monkeypatch):
    calls: list[str] = []

    def fake_imread(path):
        calls.append(str(path))
        if "a" in str(path):
            return np.zeros((20, 100, 3), dtype=np.uint8)
        return np.zeros((20, 100, 3), dtype=np.uint8)

    def fake_build_text_mask(img, *, white_thresh=0):
        name = calls[-1]
        if "same" in name:
            return _ink_mask(10, 18, 5, 95, h=20, w=100)
        if "diff" in name:
            return _ink_mask(10, 18, 50, 95, h=20, w=100)
        return _ink_mask(10, 18, 5, 95, h=20, w=100)

    import cv2

    monkeypatch.setattr(cv2, "imread", fake_imread)
    import subtitle.visual_ocr_gate as gate

    monkeypatch.setattr(gate, "build_text_mask", fake_build_text_mask)

    shells = [
        {"start": 0.0, "end": 1.0, "ocr_idx": 0, "ocr_path": "same_0.png", "select_reason": "appear"},
        {"start": 1.0, "end": 2.0, "ocr_idx": 10, "ocr_path": "same_1.png", "select_reason": "change"},
        {"start": 2.0, "end": 3.0, "ocr_idx": 20, "ocr_path": "diff_0.png", "select_reason": "change"},
    ]
    logs: list[str] = []
    merged, skipped = merge_cue_shells_by_mask(
        shells,
        white_thresh=0,
        merge_iou=0.72,
        log=logs.append,
        label="test",
    )
    assert len(merged) == 2
    assert skipped == 1
    assert merged[0]["end"] == pytest.approx(2.0)
    assert any("mask merge" in line for line in logs)
