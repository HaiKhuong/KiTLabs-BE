"""Parse CallA-1 review-style markdown into story knowledge."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "recap"))

from call_a1_story_analyst import parse_story_analysis_markdown  # noqa: E402


SAMPLE = """## I. Nhận diện cơ bản
- Tên tác phẩm: Lục Tranh: Kỷ Nguyên Công Nghiệp
- Phạm vi phụ đề: 00:00:01,200 --> 01:27:32,299
- Tình tiết thực tế trong phụ đề:
  1. Lục Tranh xuyên không cứu Tô gia.
  2. Chế tạo súng và tàu thiết giáp.
- Thông tin chưa diễn ra: Kế hoạch chế tạo máy bay.

## II. Nhân vật & Mối quan hệ
| Tên thống nhất (Hán Việt) | Tên trong phụ đề | Thân phận / Quan hệ | Động cơ / Lập trường hiện tại | Độ xác thực |
|---|---|---|---|---|
| Lục Tranh | Lục Tranh, Tranh Ca | Nhân vật chính, người xuyên không | Cứu Đại Càn bằng công nghiệp | Phụ đề xác nhận |
| Tô Thanh Hàn | Đại tiểu thư | Vợ chưa cưới | Ủng hộ Lục Tranh | Phụ đề xác nhận |

## III. Tóm tắt cốt truyện tổng thể
Bộ phim kể về Lục Tranh xuyên không về Đại Càn và công nghiệp hóa vương triều.

## IV. Phân tích chi tiết từng phân đoạn
| Video | Mốc thời gian (Timestamp) | Chủ đề đoạn | Sự kiện diễn ra | Chức năng tự sự |
|---|---|---|---|---|
| clip.mp4 | 00:00:01,200 --> 00:00:23,556 | Họa diệt môn | Tô gia bị ép giao 1 vạn đao | Mở màn |
| clip.mp4 | 00:00:23,566 --> 00:00:55,228 | Hứa hẹn công nghiệp | Lục Tranh tuyên bố cách mạng | Đẩy cao trào |

## V. Trọng tâm sáng tác thuyết minh
- Câu mở đầu (Hook): Ngày đầu xuyên không đã gặp họa diệt môn?
- Xung đột cốt lõi: Khoa học hiện đại đối đầu quan lại cũ.
- Điểm giữ chân khán giả: Mỗi thách thức là một phát minh mới.
"""


class TestCallA1AnalysisParse(unittest.TestCase):
    def test_parse_review_markdown(self) -> None:
        knowledge = parse_story_analysis_markdown(
            SAMPLE,
            movie_title="Fallback",
            movie_dur=5252.3,
            video_name="clip.mp4",
        )
        self.assertEqual(knowledge["movieTitle"], "Lục Tranh: Kỷ Nguyên Công Nghiệp")
        self.assertIn("Lục Tranh xuyên không", knowledge["movieSummary"])
        self.assertEqual(len(knowledge["characters"]), 2)
        self.assertEqual(knowledge["characters"][0]["name"], "Lục Tranh")
        self.assertEqual(len(knowledge["events"]), 2)
        self.assertAlmostEqual(knowledge["events"][0]["window"]["from"], 1.2, places=1)
        self.assertEqual(knowledge["events"][0]["title"], "Họa diệt môn")
        self.assertEqual(knowledge["events"][0]["narrativeFunction"], "Mở màn")
        self.assertEqual(knowledge["plotFacts"][0], "Lục Tranh xuyên không cứu Tô gia.")
        self.assertIn("họa diệt môn", knowledge["creativeFocus"]["hook"].lower())


if __name__ == "__main__":
    unittest.main()
