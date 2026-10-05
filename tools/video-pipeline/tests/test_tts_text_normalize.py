"""TTS acronym rules — default list + configurable overrides."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tts_text_normalize import (  # noqa: E402
    apply_tts_acronym_rules,
    configure_tts_acronym_rules,
)


class TestTtsAcronymRules(unittest.TestCase):
    def tearDown(self) -> None:
        configure_tts_acronym_rules(None)

    def test_default_sss_ss_s(self) -> None:
        self.assertEqual(apply_tts_acronym_rules("SSS rank"), "Ba Ét rank")
        self.assertEqual(apply_tts_acronym_rules("S S S rank"), "Ba Ét rank")
        self.assertEqual(apply_tts_acronym_rules("SS rank"), "Hai Ét rank")
        self.assertEqual(apply_tts_acronym_rules("S rank"), "Ét rank")

    def test_default_words(self) -> None:
        self.assertEqual(apply_tts_acronym_rules("HACK hệ thống"), "Hách hệ thống")
        self.assertEqual(apply_tts_acronym_rules("Mecha war"), "Mê cha war")
        self.assertEqual(apply_tts_acronym_rules("Haiz"), "Hài")
        self.assertEqual(apply_tts_acronym_rules("Haizzz"), "Hài")
        self.assertEqual(apply_tts_acronym_rules("A.I và AI"), "Ây Ai và Ây Ai")
        self.assertEqual(apply_tts_acronym_rules("đi thôi, đi thôi"), "Đi thôi")

    def test_custom_rules_override(self) -> None:
        configure_tts_acronym_rules([{"from": "NPC", "to": "Nờ Bi Xi", "match": "word"}])
        self.assertEqual(apply_tts_acronym_rules("gặp NPC kia"), "gặp Nờ Bi Xi kia")
        self.assertEqual(apply_tts_acronym_rules("SSS"), "SSS")

    def test_empty_rules_disable(self) -> None:
        configure_tts_acronym_rules([])
        self.assertEqual(apply_tts_acronym_rules("SSS HACK"), "SSS HACK")

    def test_none_restores_defaults(self) -> None:
        configure_tts_acronym_rules([])
        configure_tts_acronym_rules(None)
        self.assertEqual(apply_tts_acronym_rules("SSS"), "Ba Ét")


if __name__ == "__main__":
    unittest.main()
