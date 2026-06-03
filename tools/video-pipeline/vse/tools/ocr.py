"""OCR recogniser using PaddleOCR (detection + recognition)."""

from paddleocr import PaddleOCR

from .hardware_accelerator import HardwareAccelerator
from .paddle_model_config import PaddleModelConfig


class OcrRecogniser:
    """Full OCR pipeline: text detection + recognition."""

    def __init__(self):
        self.recogniser = None
        self.hardware_accelerator = HardwareAccelerator()

    @staticmethod
    def y_round(y):
        y_min = y + 10 - y % 10
        y_max = y - y % 10
        if abs(y - y_min) < abs(y - y_max):
            return y_min
        else:
            return y_max

    def predict(self, image):
        if not self.recogniser:
            self.recogniser = self.init_model()

        results = list(self.recogniser.predict_iter(image))
        if not results:
            return [], []

        res = results[0]
        dt_polys = res.get("dt_polys", [])
        rec_texts = res.get("rec_texts", [])
        rec_scores = res.get("rec_scores", [])

        if len(dt_polys) == 0:
            return [], []

        dt_box = []
        coordinate_list = []
        for poly in dt_polys:
            points = [(int(p[0]), int(p[1])) for p in poly]
            xs = [p[0] for p in points]
            ys = [p[1] for p in points]
            xmin, xmax = min(xs), max(xs)
            ymin, ymax = min(ys), max(ys)
            coordinate_list.append([xmin, xmax, ymin, ymax])
            dt_box.append(points)

        rec_res = [(text, float(score)) for text, score in zip(rec_texts, rec_scores)]

        lines = []
        for i in coordinate_list:
            rounded_y = self.y_round(i[2])
            if not any(abs(rounded_y - line_y) <= 10 for line_y in lines):
                lines.append(rounded_y)
        lines = sorted(lines)

        for i in coordinate_list:
            for j in lines:
                if abs(j - self.y_round(i[2])) <= 10:
                    i[2] = j

        to_rank_res = list(zip(coordinate_list, rec_res, dt_box))
        ranked_res = sorted(to_rank_res, key=lambda x: (x[0][2], x[0][0]))

        sorted_dt_box = []
        sorted_rec_res = []
        for coord, rec, box in ranked_res:
            xmin, xmax, ymin, ymax = coord
            sorted_dt_box.append([(xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax)])
            sorted_rec_res.append(rec)

        return sorted_dt_box, sorted_rec_res

    def init_model(self):
        model_config = PaddleModelConfig(self.hardware_accelerator)

        if self.hardware_accelerator.has_cuda():
            device = "gpu:0"
        else:
            device = "cpu"

        kwargs = dict(
            text_detection_model_dir=model_config.DET_MODEL_PATH,
            text_recognition_model_dir=model_config.REC_MODEL_PATH,
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            text_rec_score_thresh=0,
            device=device,
        )
        if model_config.DET_MODEL_NAME:
            kwargs["text_detection_model_name"] = model_config.DET_MODEL_NAME
        if model_config.REC_MODEL_NAME:
            kwargs["text_recognition_model_name"] = model_config.REC_MODEL_NAME

        return PaddleOCR(**kwargs)


def get_coordinates(dt_box):
    """Extract AABB coordinates from detection boxes."""
    coordinate_list = []
    if isinstance(dt_box, list):
        for i in dt_box:
            i = list(i)
            (x1, y1) = int(i[0][0]), int(i[0][1])
            (x2, y2) = int(i[1][0]), int(i[1][1])
            (x3, y3) = int(i[2][0]), int(i[2][1])
            (x4, y4) = int(i[3][0]), int(i[3][1])
            xmin = max(x1, x4)
            xmax = min(x2, x3)
            ymin = max(y1, y2)
            ymax = min(y3, y4)
            coordinate_list.append((xmin, xmax, ymin, ymax))
    return coordinate_list
