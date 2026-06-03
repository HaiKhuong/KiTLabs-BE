"""Text detection using PaddleOCR TextDetection."""

import numpy as np

from .paddle_model_config import PaddleModelConfig
from .hardware_accelerator import HardwareAccelerator

try:
    from paddleocr import TextDetection
except ImportError:
    TextDetection = None


class SubtitleDetect:
    """Detects text boxes in video frames (detection only, no recognition)."""

    def __init__(self):
        hardware_accelerator = HardwareAccelerator.instance()
        model_config = PaddleModelConfig(hardware_accelerator)
        kwargs = {"model_dir": model_config.DET_MODEL_PATH}
        if model_config.DET_MODEL_NAME:
            kwargs["model_name"] = model_config.DET_MODEL_NAME
        self.text_detector = TextDetection(**kwargs)

    def detect_subtitle(self, img):
        """
        Detect text boxes in image.

        Returns:
            (dt_boxes, elapse): dt_boxes is numpy array of polygons, elapse is timing (unused).
        """
        results = list(self.text_detector.predict(img))
        if not results:
            return np.array([]), 0
        res = results[0]
        dt_polys = res.get("dt_polys", np.array([]))
        return dt_polys, 0
