"""Paddle model path resolution for PP-OCRv5."""

import os
from ..config_shim import BASE_DIR, config


class PaddleModelConfig:
    def __init__(self, hardware_accelerator):
        self.hardware_accelerator = hardware_accelerator
        self.REC_CHAR_TYPE = config.language.value

        self.MODEL_BASE = os.path.join(BASE_DIR, "models")
        self.MODEL_VERSION = "V5"
        self.REC_IMAGE_SHAPE = "3,48,320"
        self.REC_MODEL_PATH = None
        self.DET_MODEL_PATH = None
        self.DET_MODEL_NAME = None
        self.REC_MODEL_NAME = None

        self.LATIN_LANG = [
            "af", "az", "bs", "cs", "cy", "da", "de", "es", "et", "fr", "ga", "hr",
            "hu", "id", "is", "it", "ku", "la", "lt", "lv", "mi", "ms", "mt", "nl",
            "no", "oc", "pi", "pl", "pt", "ro", "rs_latin", "sk", "sl", "sq", "sv",
            "sw", "tl", "tr", "uz", "vi", "latin", "german", "french",
            "fi", "eu", "gl", "lb", "rm", "ca", "qu",
        ]
        self.ARABIC_LANG = ["ar", "fa", "ug", "ur", "ps", "sd", "bal"]
        self.CYRILLIC_LANG = [
            "ru", "rs_cyrillic", "be", "bg", "uk", "mn", "abq", "ady", "kbd", "ava",
            "dar", "inh", "che", "lbe", "lez", "tab", "cyrillic",
            "sr", "kk", "ky", "tg", "mk", "tt", "cv", "ba", "mhr", "mo",
            "udm", "kv", "os", "bua", "xal", "tyv", "sah", "kaa",
        ]
        self.DEVANAGARI_LANG = [
            "hi", "mr", "ne", "bh", "mai", "ang", "bho", "mah", "sck", "new", "gom",
            "sa", "bgc", "devanagari",
        ]
        self.OTHER_LANG = ["ch", "japan", "korean", "en", "ta", "kn", "te", "ka", "chinese_cht"]
        self.MULTI_LANG = (
            self.LATIN_LANG + self.ARABIC_LANG + self.CYRILLIC_LANG
            + self.DEVANAGARI_LANG + self.OTHER_LANG
        )

        if self.REC_CHAR_TYPE in self.MULTI_LANG:
            resolved = self._resolve_models()
            if resolved:
                self.MODEL_VERSION = "V5"
                self.DET_MODEL_PATH, self.REC_MODEL_PATH, self.DET_MODEL_NAME, self.REC_MODEL_NAME = resolved

    def _get_v5_rec_model_name(self, lang):
        if lang in ("ch", "chinese_cht", "japan"):
            return "PP-OCRv5_server_rec_infer"
        elif lang == "en":
            return "PP-OCRv5_server_rec_infer"
        elif lang == "korean":
            return "korean_PP-OCRv5_mobile_rec_infer"
        elif lang in self.LATIN_LANG:
            return "latin_PP-OCRv5_mobile_rec_infer"
        elif lang in self.ARABIC_LANG:
            return "arabic_PP-OCRv5_mobile_rec_infer"
        elif lang in self.CYRILLIC_LANG:
            return "cyrillic_PP-OCRv5_mobile_rec_infer"
        elif lang in self.DEVANAGARI_LANG:
            return "devanagari_PP-OCRv5_mobile_rec_infer"
        elif lang == "th":
            return "th_PP-OCRv5_mobile_rec_infer"
        elif lang == "el":
            return "el_PP-OCRv5_mobile_rec_infer"
        elif lang == "ta":
            return "ta_PP-OCRv5_mobile_rec_infer"
        elif lang == "te":
            return "te_PP-OCRv5_mobile_rec_infer"
        return None

    @staticmethod
    def _read_model_name_from_yaml(model_dir):
        yaml_path = os.path.join(model_dir, "inference.yml")
        if not os.path.exists(yaml_path):
            return None
        try:
            with open(yaml_path, "r", encoding="utf-8") as f:
                in_global = False
                for line in f:
                    stripped = line.strip()
                    if stripped == "Global:":
                        in_global = True
                        continue
                    if in_global:
                        if stripped and not stripped.startswith("#") and ":" in stripped:
                            if stripped.startswith("model_name:"):
                                return stripped.split(":", 1)[1].strip().strip('"').strip("'")
                        if (
                            stripped
                            and not stripped.startswith("model_name")
                            and not stripped.startswith(" ")
                            and stripped.endswith(":")
                        ):
                            break
        except Exception:
            pass
        return None

    def _resolve_models(self):
        v5_base = os.path.join(self.MODEL_BASE, "V5")

        # fast mode prefers mobile model
        if config.mode.value == "fast":
            det_model_path = os.path.join(v5_base, "PP-OCRv5_mobile_det_infer")
            if not os.path.exists(det_model_path):
                det_model_path = os.path.join(v5_base, "PP-OCRv5_server_det_infer")
        else:
            det_model_path = os.path.join(v5_base, "PP-OCRv5_server_det_infer")
        if not os.path.exists(det_model_path):
            return None

        det_model_name = self._read_model_name_from_yaml(det_model_path)

        if config.mode.value == "fast":
            rec_model_path = os.path.join(v5_base, "PP-OCRv5_mobile_rec_infer")
            if os.path.exists(rec_model_path):
                rec_model_name = self._read_model_name_from_yaml(rec_model_path)
                return det_model_path, rec_model_path, det_model_name, rec_model_name

        rec_model_dir_name = self._get_v5_rec_model_name(self.REC_CHAR_TYPE)
        if rec_model_dir_name is None:
            return None

        rec_model_path = os.path.join(
            v5_base,
            f"{rec_model_dir_name}_infer" if not rec_model_dir_name.endswith("_infer") else rec_model_dir_name,
        )
        if not os.path.exists(rec_model_path):
            rec_model_path = os.path.join(v5_base, rec_model_dir_name)
        if not os.path.exists(rec_model_path):
            return None

        rec_model_name = self._read_model_name_from_yaml(rec_model_path)
        return det_model_path, rec_model_path, det_model_name, rec_model_name
