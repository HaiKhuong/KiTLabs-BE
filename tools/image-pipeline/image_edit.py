"""Local image edits: cutout, background removal, detection, upscale.

stdin: JSON { op, input_path, out_dir, models_dir, scale?, domain? }
writes out_dir/result.json and exits 0 on success.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
import urllib.request
import zipfile
from pathlib import Path

# basicsr still imports the removed torchvision.transforms.functional_tensor module.
try:
    import torchvision.transforms.functional as _tv_functional

    sys.modules.setdefault("torchvision.transforms.functional_tensor", _tv_functional)
except Exception:
    pass


WEIGHTS = {
    "yolov8s-worldv2.pt": "https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8s-worldv2.pt",
    "sam2.1_hiera_tiny.pt": "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt",
    "RealESRGAN_x4plus.pth": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
    "RealESRGAN_x4plus_anime_6B.pth": "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth",
}

MAX_OUTPUT_EDGE = 8192
MAX_CUTOUTS = 24
SAM_MAX_SIDE = 1280
# Open-vocab prompts: real people plus illustrated / cartoon icons. YOLO11n only knows COCO "person".
CUTOUT_PROMPTS = [
    "person",
    "man",
    "woman",
    "child",
    "baby",
    "cartoon character",
    "anime character",
    "animated character",
    "chibi character",
    "cartoon icon",
    "mascot",
]


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def write_result(out_dir: Path, payload: dict) -> None:
    (out_dir / "result.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def device_name() -> str:
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


def ensure_weight(models_dir: Path, filename: str) -> Path:
    target = models_dir / filename
    if target.exists() and target.stat().st_size > 1_000_000:
        return target
    url = WEIGHTS[filename]
    models_dir.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".part")
    log(f"Downloading {filename}")
    urllib.request.urlretrieve(url, tmp)
    tmp.replace(target)
    return target


def read_rgb(path: Path):
    import cv2

    bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if bgr is None:
        raise RuntimeError(f"Không đọc được ảnh: {path.name}")
    return bgr


def box_iou(a: list[float], b: list[float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def merge_overlapping(items: list[dict], iou_thresh: float = 0.45) -> list[dict]:
    kept: list[dict] = []
    for item in sorted(items, key=lambda row: row["confidence"], reverse=True):
        if any(box_iou(item["box"], other["box"]) >= iou_thresh for other in kept):
            continue
        kept.append(item)
    return kept


def box_area(box: list[float]) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def intersection_area(a: list[float], b: list[float]) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    return max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)


def union_box(a: list[float], b: list[float]) -> list[float]:
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def attach_held_accessories(items: list[dict]) -> list[dict]:
    """A smaller box touching a character (weapon, prop, icon) is part of that character."""
    hosts: list[dict] = []
    for item in sorted(items, key=lambda row: box_area(row["box"]), reverse=True):
        item_area = box_area(item["box"]) or 1.0
        host = None
        best = 0.0
        for subject in hosts:
            subject_area = box_area(subject["box"]) or 1.0
            if item_area > subject_area * 0.65:
                continue
            width = subject["box"][2] - subject["box"][0]
            height = subject["box"][3] - subject["box"][1]
            pad = 0.18 * max(width, height)
            expanded = [
                subject["box"][0] - pad,
                subject["box"][1] - pad,
                subject["box"][2] + pad,
                subject["box"][3] + pad,
            ]
            overlap = intersection_area(expanded, item["box"]) / item_area
            if overlap > best:
                best = overlap
                host = subject
        if host is not None and best >= 0.15:
            host["box"] = union_box(host["box"], item["box"])
            log(f"attach {item['label']} -> {host['label']}")
        else:
            hosts.append(item)
    return hosts


def run_subject_detect(image_path: Path, models_dir: Path, device: str):
    """People (man/woman/child/baby) and cartoon / anime icons via YOLO-World."""
    from ultralytics import YOLOWorld

    weight = ensure_weight(models_dir, "yolov8s-worldv2.pt")
    model = YOLOWorld(str(weight))
    model.set_classes(CUTOUT_PROMPTS)
    log("cutout prompts: " + ", ".join(CUTOUT_PROMPTS))
    results = model.predict(source=str(image_path), conf=0.12, iou=0.45, device=device, verbose=False)
    if not results:
        return []
    result = results[0]
    names = result.names or {}
    found = []
    boxes = result.boxes
    if boxes is None:
        return found
    for box in boxes:
        xyxy = [float(v) for v in box.xyxy[0].tolist()]
        conf = float(box.conf[0])
        cls_id = int(box.cls[0])
        label = str(names.get(cls_id, cls_id))
        found.append({"label": label, "confidence": round(conf, 4), "box": xyxy})
    return merge_overlapping(attach_held_accessories(found))[:MAX_CUTOUTS]


def run_detect(image_path: Path, out_dir: Path, models_dir: Path, device: str) -> dict:
    import cv2

    detections = run_subject_detect(image_path, models_dir, device)
    bgr = read_rgb(image_path)
    for item in detections:
        x1, y1, x2, y2 = [int(round(v)) for v in item["box"]]
        cv2.rectangle(bgr, (x1, y1), (x2, y2), (80, 180, 255), 2)
        caption = f"{item['label']} {item['confidence']:.2f}"
        cv2.putText(bgr, caption, (x1, max(18, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (80, 180, 255), 1, cv2.LINE_AA)
    result_name = "result.png"
    cv2.imwrite(str(out_dir / result_name), bgr)
    return {"resultFile": result_name, "files": [{"name": result_name}], "detections": detections}


def run_cutout(image_path: Path, out_dir: Path, models_dir: Path, device: str) -> dict:
    import cv2
    import numpy as np
    import torch
    from sam2.build_sam import build_sam2
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    detections = run_subject_detect(image_path, models_dir, device)
    if not detections:
        raise RuntimeError("Không tìm thấy object trong ảnh")

    bgr = read_rgb(image_path)
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    height, width = rgb.shape[:2]
    scale = min(1.0, SAM_MAX_SIDE / max(height, width))
    if scale < 1:
        small = cv2.resize(rgb, (max(1, int(width * scale)), max(1, int(height * scale))), interpolation=cv2.INTER_AREA)
    else:
        small = rgb

    checkpoint = ensure_weight(models_dir, "sam2.1_hiera_tiny.pt")
    sam = build_sam2("configs/sam2.1/sam2.1_hiera_t.yaml", str(checkpoint), device=device)
    predictor = SAM2ImagePredictor(sam)
    predictor.set_image(small)

    files = []
    for index, item in enumerate(detections, start=1):
        box = np.array(item["box"], dtype=np.float32) * scale
        masks, _scores, _ = predictor.predict(box=box, multimask_output=False)
        mask_small = masks[0].astype(np.uint8)
        mask = cv2.resize(mask_small, (width, height), interpolation=cv2.INTER_NEAREST).astype(bool)
        if int(mask.sum()) < 16:
            continue
        ys, xs = np.where(mask)
        x1, x2 = int(xs.min()), int(xs.max())
        y1, y2 = int(ys.min()), int(ys.max())
        alpha = (mask.astype(np.uint8) * 255)[y1 : y2 + 1, x1 : x2 + 1]
        crop = rgb[y1 : y2 + 1, x1 : x2 + 1]
        rgba = np.dstack([crop, alpha])
        name = f"object-{index:02d}.png"
        cv2.imwrite(str(out_dir / name), cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
        files.append({"name": name, "label": item["label"], "confidence": item["confidence"]})

    if not files:
        raise RuntimeError("Không tách được object nào")

    zip_name = "objects.zip"
    with zipfile.ZipFile(out_dir / zip_name, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for item in files:
            archive.write(out_dir / item["name"], arcname=item["name"])

    del predictor, sam
    if device == "cuda":
        torch.cuda.empty_cache()

    return {"resultFile": zip_name, "files": files, "detections": detections}


def run_remove_bg(image_path: Path, out_dir: Path, device: str) -> dict:
    import torch
    from PIL import Image
    from torchvision import transforms
    from transformers import AutoModelForImageSegmentation

    image = Image.open(image_path).convert("RGB")
    # briaai/RMBG-2.0 is a gated Hugging Face repo. BiRefNet is the public model RMBG-2.0 is built on.
    model_id = os.environ.get("IMAGE_EDIT_RMBG_MODEL", "ZhengPeng7/BiRefNet").strip() or "ZhengPeng7/BiRefNet"
    log(f"remove-bg model={model_id}")
    try:
        import kornia  # noqa: F401
        import timm  # noqa: F401
    except ImportError as exc:
        raise RuntimeError(
            "Tách nền cần kornia và timm. Mở Settings → Môi trường Python → Cài thư viện xử lý ảnh."
        ) from exc
    model = AutoModelForImageSegmentation.from_pretrained(model_id, trust_remote_code=True)
    model.to(device)
    model.eval()

    transform = transforms.Compose(
        [
            transforms.Resize((1024, 1024)),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )
    batch = transform(image).unsqueeze(0).to(device)
    with torch.no_grad():
        preds = model(batch)[-1].sigmoid().cpu()
    pred = preds[0].squeeze()
    mask = transforms.ToPILImage()(pred).resize(image.size)
    rgba = image.copy()
    rgba.putalpha(mask)
    result_name = "result.png"
    rgba.save(out_dir / result_name)
    del model
    if device == "cuda":
        torch.cuda.empty_cache()
    return {"resultFile": result_name, "files": [{"name": result_name}], "detections": []}


def run_upscale(image_path: Path, out_dir: Path, models_dir: Path, device: str, scale: int, domain: str) -> dict:
    import cv2
    from realesrgan_infer import build_model, enhance

    if scale not in (2, 4):
        raise RuntimeError("scale phải là 2 hoặc 4")
    if domain not in ("photo", "anime"):
        raise RuntimeError("domain phải là photo hoặc anime")

    bgr = read_rgb(image_path)
    height, width = bgr.shape[:2]
    if max(height, width) * scale > MAX_OUTPUT_EDGE:
        raise RuntimeError(f"Cạnh ảnh sau upscale vượt {MAX_OUTPUT_EDGE}px")

    weight_name = "RealESRGAN_x4plus_anime_6B.pth" if domain == "anime" else "RealESRGAN_x4plus.pth"
    weight = ensure_weight(models_dir, weight_name)
    log(f"upscale domain={domain} scale={scale} weight={weight.name}")
    model = build_model(domain, weight, device)
    output = enhance(bgr, model, device, outscale=scale)
    del model
    if device == "cuda":
        import torch

        torch.cuda.empty_cache()
    result_name = "result.png"
    cv2.imwrite(str(out_dir / result_name), output)
    return {"resultFile": result_name, "files": [{"name": result_name}], "detections": []}


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        log(f"Invalid JSON: {exc}")
        return 1

    out_dir = Path(payload.get("out_dir") or "")
    if not out_dir:
        log("out_dir is required")
        return 1
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        op = payload.get("op")
        image_path = Path(payload["input_path"])
        models_dir = Path(payload.get("models_dir") or "models/image-edit")
        models_dir.mkdir(parents=True, exist_ok=True)
        device = device_name()
        log(f"op={op} device={device}")

        if op == "cutout":
            data = run_cutout(image_path, out_dir, models_dir, device)
        elif op == "remove-bg":
            data = run_remove_bg(image_path, out_dir, device)
        elif op == "detect":
            data = run_detect(image_path, out_dir, models_dir, device)
        elif op == "upscale":
            data = run_upscale(
                image_path,
                out_dir,
                models_dir,
                device,
                int(payload.get("scale") or 4),
                str(payload.get("domain") or "photo"),
            )
        else:
            raise RuntimeError(f"op không hỗ trợ: {op}")

        write_result(out_dir, {"ok": True, **data})
        return 0
    except Exception as exc:
        log(traceback.format_exc())
        write_result(out_dir, {"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
