import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


PIPELINE_DIR = Path(__file__).resolve().parents[1]
if str(PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(PIPELINE_DIR))


class _FakeGeminiClient:
    def __init__(self, **_kwargs):
        pass


fake_genai = types.ModuleType("google.genai")
fake_genai.Client = _FakeGeminiClient
fake_google = types.ModuleType("google")
fake_google.genai = fake_genai
sys.modules.setdefault("google", fake_google)
sys.modules.setdefault("google.genai", fake_genai)

import step2_gemini


def parse_srt(text: str) -> list[dict]:
    blocks = []
    for chunk in text.strip().split("\n\n"):
        lines = chunk.splitlines()
        blocks.append({"index": int(lines[0]), "time": lines[1], "text": "\n".join(lines[2:])})
    return blocks


def write_srt(blocks: list[dict], path: Path) -> None:
    path.write_text(
        "".join(f"{block['index']}\n{block['time']}\n{block['text']}\n\n" for block in blocks),
        encoding="utf-8",
    )


class Step2GeminiCheckpointTest(unittest.TestCase):
    def test_rerun_only_requests_batches_without_a_valid_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "zh.srt"
            output = root / "vi.srt"
            source.write_text(
                "".join(
                    f"{index}\n00:00:{index:02d},000 --> 00:00:{index:02d},500\n源 {index}\n\n"
                    for index in range(1, 9)
                ),
                encoding="utf-8",
            )
            step2_gemini.configure_step2_gemini(
                log=lambda _message: None,
                write_text=lambda path, content: path.write_text(content, encoding="utf-8"),
                append_text=lambda path, content: path.open("a", encoding="utf-8").write(content),
                parse_srt=parse_srt,
                write_srt=write_srt,
                progressbar=lambda iterable, **_kwargs: iterable,
                retry_call=lambda fn, *_args, **_kwargs: fn(),
                get_vi_srt_path=lambda: output,
                log_dir=root / "logs",
                gemini_api_keys=["test-key"],
                gemini_model_name="test-model",
                gemini_retry_max=0,
                translate_batch_size=2,
                translation_context="test-context",
                step2_multi_keys_enabled=False,
            )

            first_calls = []

            def fail_fourth(batch: list[dict], start: int) -> dict[int, str]:
                first_calls.append(start)
                if start == 6:
                    raise RuntimeError("request 4 failed")
                return {idx: f"dịch {block['index']}" for idx, block in enumerate(batch)}

            with patch.object(step2_gemini, "translate_batch_with_gemini", side_effect=fail_fourth):
                with self.assertRaisesRegex(RuntimeError, "request 4 failed"):
                    step2_gemini.step2_translate_srt(source)

            self.assertEqual(first_calls, [0, 2, 4, 6])
            self.assertFalse(output.exists())

            rerun_calls = []

            def complete(batch: list[dict], start: int) -> dict[int, str]:
                rerun_calls.append(start)
                return {idx: f"dịch {block['index']}" for idx, block in enumerate(batch)}

            with patch.object(step2_gemini, "translate_batch_with_gemini", side_effect=complete):
                step2_gemini.step2_translate_srt(source)

            self.assertEqual(rerun_calls, [6])
            self.assertTrue(output.is_file())
            self.assertEqual(len(parse_srt(output.read_text(encoding="utf-8"))), 8)


if __name__ == "__main__":
    unittest.main()
