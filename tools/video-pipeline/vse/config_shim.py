"""
Config shim for VSE - replaces qfluentwidgets config system.

Provides a `config` object with `.value` attributes that VSE code reads.
Injected by vse_runner before importing SubtitleExtractor.
"""

import os
import configparser
from pathlib import Path
from types import SimpleNamespace

from .tools.constant import SubtitleArea as SubtitleAreaEnum, VideoSubFinderDecoder


class ConfigValue:
    """Wrapper to expose config value via .value attribute (VSE pattern)."""

    def __init__(self, value):
        self._value = value

    @property
    def value(self):
        return self._value

    @value.setter
    def value(self, v):
        self._value = v

    def __repr__(self):
        return f"ConfigValue({self._value!r})"


class VseConfig:
    """
    Headless config object mimicking qfluentwidgets Config for VSE.

    Attributes mirror backend/config.py Config class but use plain values
    instead of ConfigItem/OptionsConfigItem.
    """

    def __init__(
        self,
        language: str = "ch",
        mode: str = "auto",  # fast | auto | accurate
        hardware_acceleration: bool = True,
        extract_frequency: int = 3,
        drop_score: int = 75,
        threshold_text_similarity: int = 80,
        subtitle_area_deviation_rate: int = 0,
        subtitle_area: SubtitleAreaEnum = SubtitleAreaEnum.UNKNOWN,
        video_subfinder_decoder: VideoSubFinderDecoder = VideoSubFinderDecoder.OPENCV,
        video_subfinder_cpu_cores: int = 0,
        generate_txt: bool = False,
        word_segmentation: bool = False,
        debug_ocr_loss: bool = False,
        debug_no_delete_cache: bool = False,
        delete_empty_timestamp: bool = True,
    ):
        self.language = ConfigValue(language)
        self.mode = ConfigValue(mode)
        self.hardwareAcceleration = ConfigValue(hardware_acceleration)
        self.extractFrequency = ConfigValue(extract_frequency)
        self.dropScore = ConfigValue(drop_score)
        self.thresholdTextSimilarity = ConfigValue(threshold_text_similarity)
        self.subtitleAreaDeviationRate = ConfigValue(subtitle_area_deviation_rate)
        self.subtitleArea = ConfigValue(subtitle_area)
        self.videoSubFinderDecoder = ConfigValue(video_subfinder_decoder)
        self.videoSubFinderCpuCores = ConfigValue(video_subfinder_cpu_cores)
        self.generateTxt = ConfigValue(generate_txt)
        self.wordSegmentation = ConfigValue(word_segmentation)
        self.debugOcrLoss = ConfigValue(debug_ocr_loss)
        self.debugNoDeleteCache = ConfigValue(debug_no_delete_cache)
        self.deleteEmptyTimeStamp = ConfigValue(delete_empty_timestamp)


# Global config instance - will be replaced by install()
config = VseConfig()

# BASE_DIR points to vse/ folder
BASE_DIR = str(Path(__file__).parent)

# Translation dict (minimal English fallback)
tr = configparser.ConfigParser()
_INTERFACE_FILE = Path(__file__).parent / "interface" / "en.ini"
if _INTERFACE_FILE.exists():
    tr.read(str(_INTERFACE_FILE), encoding="utf-8")
else:
    # Minimal fallback if en.ini not present
    tr["Main"] = {
        "RecSubLang": "Subtitle Language",
        "RecMode": "Mode",
        "AcceleratorON": "Use {} for acceleration",
        "FrameCount": "Frame Count",
        "FrameRate": "Frame Rate",
        "StartProcessFrame": "[Processing] Extracting video keyframes...",
        "FinishProcessFrame": "[Finished] Video keyframes extracted",
        "FinishFindSub": "[Finished] Subtitle content recognized",
        "StartGenerateSub": "[Processing] Generating subtitle file...",
        "FinishGenerateSub": "[Finished] Subtitle file generated successfully",
        "SubLocation": "[Done] Subtitle file location: {}",
        "OcrDropNoIntercetion": "Out of selection",
        "OcrDropOutOfBoxRate": "Exceeds allowed deviation: {0}%  Current: {1}%",
        "OcrDropConfidentLow": "Confidence below threshold: {0}%",
        "OcrResult": "√ Confidence: {1}% Result: {0}",
        "OcrResultWithDropReason": "× Confidence: {1}% Result: {0} Drop reason: {2}",
        "OnnxExectionProviderNotSupportedSkipped": "ONNX Execution Provider: {} not supported, skipped.",
        "OnnxExecutionProviderDetected": "Detected ONNX execution provider: {}",
        "OnnxRuntimeNotInstall": "ONNX runtime not installed, skipped.",
    }

# Ensure env var for paddle
os.environ["KMP_DUPLICATE_LIB_OK"] = "True"


def install(cfg: VseConfig):
    """Replace global config with the given VseConfig instance."""
    global config
    config = cfg


def create_config(
    language: str = "ch",
    mode: str = "auto",
    hardware_acceleration: bool = True,
    extract_frequency: int = 3,
    drop_score: int = 75,
    threshold_text_similarity: int = 80,
    subtitle_area_deviation_rate: int = 0,
    video_subfinder_decoder: str = "opencv",
    video_subfinder_cpu_cores: int = 0,
) -> VseConfig:
    """Factory to create VseConfig from simple values."""
    decoder_map = {
        "opencv": VideoSubFinderDecoder.OPENCV,
        "ffmpeg": VideoSubFinderDecoder.FFMPEG,
    }
    return VseConfig(
        language=language,
        mode=mode,
        hardware_acceleration=hardware_acceleration,
        extract_frequency=extract_frequency,
        drop_score=drop_score,
        threshold_text_similarity=threshold_text_similarity,
        subtitle_area_deviation_rate=subtitle_area_deviation_rate,
        video_subfinder_decoder=decoder_map.get(
            video_subfinder_decoder.lower(), VideoSubFinderDecoder.OPENCV
        ),
        video_subfinder_cpu_cores=video_subfinder_cpu_cores,
    )
