"""
SubtitleExtractor - main VSE pipeline (headless Linux adaptation).

Adapted from video-subtitle-extractor v2.2.0 for KiTLabs.
- Removed GUI/CLI interactive prompts
- Linux-only VSF support
- Paths redirected to KiTLabs LOG_DIR
"""

import os
import re
import shutil
import subprocess
import sys
import threading
import time
import multiprocessing
from collections import Counter, namedtuple
from pathlib import Path

import cv2
import pysrt
from Levenshtein import ratio
from tqdm import tqdm

from .config_shim import config, BASE_DIR, tr
from .tools.hardware_accelerator import HardwareAccelerator
from .tools.ocr import OcrRecogniser, get_coordinates
from .tools import subtitle_ocr
from .tools.paddle_model_config import PaddleModelConfig
from .tools.process_manager import ProcessManager
from .tools.subtitle_detect import SubtitleDetect
from .bean.subtitle_area import SubtitleArea


def _is_wsl() -> bool:
    """Detect if running on WSL."""
    try:
        return "microsoft" in Path("/proc/version").read_text(
            encoding="utf-8", errors="ignore"
        ).lower()
    except OSError:
        return False


def _vsf_disabled() -> bool:
    """Check if VideoSubFinder should be disabled (WSL or env flag)."""
    flag = os.environ.get("VSE_DISABLE_VSF", "").strip().lower()
    if flag in ("1", "true", "yes", "on"):
        return True
    return _is_wsl()


class SubtitleExtractor:
    """Video subtitle extractor using PaddleOCR + optional VideoSubFinder."""

    def __init__(self, vd_path, temp_output_dir=None, subtitle_output_path=None, log_func=None):
        """
        Args:
            vd_path: Path to video file.
            temp_output_dir: Override temp directory (default: alongside video).
            subtitle_output_path: Override SRT output path.
            log_func: Optional logging function (default: print).
        """
        self.lock = threading.RLock()
        self.sub_area = None
        self.hardware_accelerator = HardwareAccelerator.instance()
        self.hardware_accelerator.set_enabled(config.hardwareAcceleration.value)
        self.model_config = PaddleModelConfig(self.hardware_accelerator)
        self.sub_detector = SubtitleDetect()
        self.video_path = vd_path
        self.video_cap = cv2.VideoCapture(vd_path)
        self.vd_name = Path(self.video_path).stem

        # Allow override of temp/output directories
        if temp_output_dir:
            self.temp_output_dir = str(temp_output_dir)
        else:
            self.temp_output_dir = os.path.join(os.path.dirname(vd_path), "output", str(self.vd_name))

        self.frame_count = self.video_cap.get(cv2.CAP_PROP_FRAME_COUNT)
        self.fps = self.video_cap.get(cv2.CAP_PROP_FPS)
        self.frame_height = int(self.video_cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.frame_width = int(self.video_cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.frame_output_dir = os.path.join(self.temp_output_dir, "frames")
        self.subtitle_output_dir = os.path.join(self.temp_output_dir, "subtitle")
        self.use_vsf = False
        self.vsf_subtitle = os.path.join(self.subtitle_output_dir, "raw_vsf.srt")
        self.raw_subtitle_path = os.path.join(self.subtitle_output_dir, "raw.txt")

        if subtitle_output_path:
            self.subtitle_output_path = str(subtitle_output_path)
        else:
            self.subtitle_output_path = os.path.splitext(self.video_path)[0] + ".srt"

        self.ocr = None
        self.progress_total = 200
        self.progress_frame_extract = 0
        self.progress_ocr = 0
        self.isFinished = False
        self.subtitle_ocr_task_queue = None
        self.subtitle_ocr_progress_queue = None
        self.vsf_running = False
        self.progress_listeners = []

        self._log_func = log_func or print

    def log(self, *args, **kwargs):
        self._log_func(*args, **kwargs)

    def append_output(self, *args):
        msg = " ".join(str(a) for a in args)
        self.log(msg)

    def update_progress(self, ocr=None, frame_extract=None):
        if ocr is not None:
            self.progress_ocr = ocr
        if frame_extract is not None:
            self.progress_frame_extract = frame_extract

    def run(self):
        """Run full extraction pipeline."""
        start_time = time.time()
        self.lock.acquire()
        try:
            self.update_progress(ocr=0, frame_extract=0)
            self.append_output("-----------------------------")
            self.append_output(f"  Language: {config.language.value}  |  Mode: {config.mode.value}")
            if self.hardware_accelerator.has_accelerator():
                self.append_output(f"  Using {self.hardware_accelerator.accelerator_name} for acceleration")
            self.append_output(f"  Frame Count: {self.frame_count}  |  Frame Rate: {self.fps}")
            self.append_output(
                f"  DET: {os.path.basename(self.model_config.DET_MODEL_PATH or 'N/A')}  |  "
                f"REC: {os.path.basename(self.model_config.REC_MODEL_PATH or 'N/A')}"
            )
            self.append_output("-----------------------------")
            self.append_output("[Processing] Extracting video keyframes...")

            self._delete_frame_cache()
            os.makedirs(self.frame_output_dir, exist_ok=True)
            os.makedirs(self.subtitle_output_dir, exist_ok=True)

            subtitle_ocr_process = self._start_subtitle_ocr_async()

            if self.sub_area is not None:
                use_det = config.mode.value == "accurate" or _vsf_disabled()
                if use_det:
                    if _vsf_disabled() and config.mode.value != "accurate":
                        self.append_output(
                            "[INFO] VideoSubFinder skipped (WSL or VSE_DISABLE_VSF); "
                            "using Paddle DET frame scan."
                        )
                    self._extract_frame_by_det()
                else:
                    self._extract_frame_by_vsf()
            else:
                self._extract_frame_by_fps()

            self.subtitle_ocr_task_queue.put((self.frame_count, -1, None, None, None, None))
            subtitle_ocr_process.join()

            self.append_output("[Finished] Video keyframes extracted")
            self.append_output("[Finished] Subtitle content recognized")
            self.append_output("[Processing] Generating subtitle file...")

            if self.use_vsf:
                self._generate_subtitle_file_vsf()
            else:
                self._generate_subtitle_file()

            self.append_output(f"[Finished] Subtitle file generated successfully ({round(time.time() - start_time, 2)}s)")
            self.append_output("-----------------------------")
            self.update_progress(ocr=100, frame_extract=100)
            self.isFinished = True
            self._empty_cache()
        finally:
            self.lock.release()

    def _delete_frame_cache(self):
        if os.path.exists(self.temp_output_dir) and not config.debugNoDeleteCache.value:
            shutil.rmtree(self.temp_output_dir, ignore_errors=True)

    def _empty_cache(self):
        if not config.debugNoDeleteCache.value:
            shutil.rmtree(self.temp_output_dir, ignore_errors=True)

    def _start_subtitle_ocr_async(self):
        options = {
            "REC_CHAR_TYPE": config.language.value,
            "DROP_SCORE": config.dropScore.value / 100.0,
            "SUB_AREA_DEVIATION_RATE": config.subtitleAreaDeviationRate.value / 100.0,
            "DEBUG_OCR_LOSS": config.debugOcrLoss.value,
            "HARDWARD_ACCELERATOR": self.hardware_accelerator,
        }
        p, task_queue, progress_queue = subtitle_ocr.async_start(
            self.video_path, self.raw_subtitle_path, self.sub_area, options
        )
        self.subtitle_ocr_task_queue = task_queue
        self.subtitle_ocr_progress_queue = progress_queue
        return p

    def _extract_frame_by_fps(self):
        """Extract frames at fixed FPS (fallback when no ROI)."""
        frame_interval = int(self.fps // config.extractFrequency.value)
        if frame_interval < 1:
            frame_interval = 1
        current_frame_no = 0
        total_frames = int(self.frame_count)
        while current_frame_no < total_frames:
            self.video_cap.set(cv2.CAP_PROP_POS_FRAMES, current_frame_no)
            ret, frame = self.video_cap.read()
            if not ret:
                break
            current_frame_no += 1
            task = (self.frame_count, current_frame_no, None, None, None, config.subtitleArea.value)
            self.subtitle_ocr_task_queue.put(task)
            self.update_progress(frame_extract=(current_frame_no / self.frame_count) * 100)
            current_frame_no = current_frame_no + frame_interval - 1
        self.video_cap.release()

    def _extract_frame_by_det(self):
        """Extract frames by detecting text presence (accurate mode)."""
        current_frame_no = 0
        frame_lru_list = []
        frame_lru_list_max_size = 2
        ocr_args_list = []
        compare_ocr_result_cache = {}
        tbar = tqdm(total=int(self.frame_count), unit="f", position=0, file=sys.__stdout__)
        first_flag = True
        is_finding_start_frame_no = False
        is_finding_end_frame_no = False
        start_frame_no = 0
        start_end_frame_no = []
        start_frame = None
        if self.ocr is None:
            self.ocr = OcrRecogniser()

        while self.video_cap.isOpened():
            ret, frame = self.video_cap.read()
            if not ret:
                break
            current_frame_no += 1
            tbar.update(1)
            dt_boxes, elapse = self.sub_detector.detect_subtitle(frame)
            has_subtitle = False
            sub_area = self.sub_area
            if sub_area is not None:
                coordinate_list = get_coordinates(dt_boxes.tolist())
                if coordinate_list:
                    for coordinate in coordinate_list:
                        xmin, xmax, ymin, ymax = coordinate
                        if (
                            sub_area.xmin <= xmin
                            and xmax <= sub_area.xmax
                            and sub_area.ymin <= ymin
                            and ymax <= sub_area.ymax
                        ):
                            has_subtitle = True
                            if first_flag:
                                is_finding_start_frame_no = True
                                first_flag = False
                            break
            else:
                has_subtitle = len(dt_boxes) > 0

            if has_subtitle:
                if is_finding_start_frame_no:
                    start_frame_no = current_frame_no
                    dt_box, rec_res = self.ocr.predict(frame)
                    area_text1 = "".join(self._get_area_text((dt_box, rec_res)))
                    if start_frame_no not in compare_ocr_result_cache:
                        compare_ocr_result_cache[current_frame_no] = {
                            "text": area_text1,
                            "dt_box": dt_box,
                            "rec_res": rec_res,
                        }
                        frame_lru_list.append((frame, current_frame_no))
                        ocr_args_list.append((self.frame_count, current_frame_no))
                        start_frame = frame
                    is_finding_start_frame_no = False
                    is_finding_end_frame_no = True

                if is_finding_end_frame_no and current_frame_no == self.frame_count:
                    is_finding_end_frame_no = False
                    is_finding_start_frame_no = False
                    end_frame_no = current_frame_no
                    frame_lru_list.append((frame, current_frame_no))
                    ocr_args_list.append((self.frame_count, current_frame_no))
                    start_end_frame_no.append((start_frame_no, end_frame_no))

                if is_finding_end_frame_no:
                    if not self._compare_ocr_result(
                        compare_ocr_result_cache, None, start_frame_no, frame, current_frame_no
                    ):
                        is_finding_end_frame_no = False
                        is_finding_start_frame_no = True
                        end_frame_no = current_frame_no - 1
                        frame_lru_list.append((start_frame, end_frame_no))
                        ocr_args_list.append((self.frame_count, end_frame_no))
                        start_end_frame_no.append((start_frame_no, end_frame_no))
            else:
                if is_finding_end_frame_no:
                    end_frame_no = current_frame_no - 1
                    is_finding_end_frame_no = False
                    is_finding_start_frame_no = True
                    frame_lru_list.append((start_frame, end_frame_no))
                    ocr_args_list.append((self.frame_count, end_frame_no))
                    start_end_frame_no.append((start_frame_no, end_frame_no))

            while len(frame_lru_list) > frame_lru_list_max_size:
                frame_lru_list.pop(0)

            while len(ocr_args_list) > 1:
                total_frame_count, ocr_info_frame_no = ocr_args_list.pop(0)
                if current_frame_no in compare_ocr_result_cache:
                    predict_result = compare_ocr_result_cache[current_frame_no]
                    dt_box, rec_res = predict_result["dt_box"], predict_result["rec_res"]
                else:
                    dt_box, rec_res = None, None
                task = (total_frame_count, ocr_info_frame_no, dt_box, rec_res, None, config.subtitleArea.value)
                self.subtitle_ocr_task_queue.put(task)
                self.update_progress(frame_extract=(current_frame_no / self.frame_count) * 100)

        while len(ocr_args_list) > 0:
            total_frame_count, ocr_info_frame_no = ocr_args_list.pop(0)
            if current_frame_no in compare_ocr_result_cache:
                predict_result = compare_ocr_result_cache[current_frame_no]
                dt_box, rec_res = predict_result["dt_box"], predict_result["rec_res"]
            else:
                dt_box, rec_res = None, None
            task = (total_frame_count, ocr_info_frame_no, dt_box, rec_res, None, config.subtitleArea.value)
            self.subtitle_ocr_task_queue.put(task)
        self.video_cap.release()

    def _extract_frame_by_vsf(self):
        """Extract frames using VideoSubFinder (Linux only)."""
        self.use_vsf = True
        if self.video_cap:
            self.video_cap.release()
            self.video_cap = None

        def vsf_output(out):
            duration_ms = (self.frame_count / self.fps) * 1000
            last_total_ms = 0
            for line in iter(out.readline, b""):
                line = line.decode("utf-8")
                if line.startswith("Frame: "):
                    line = line.replace("\n", "").replace("Frame: ", "")
                    h, m, s, ms = line.split("__")[0].split("_")
                    total_ms = int(ms) + int(s) * 1000 + int(m) * 60 * 1000 + int(h) * 60 * 60 * 1000
                    if total_ms > last_total_ms:
                        frame_no = int(total_ms / self.fps)
                        task = (self.frame_count, frame_no, None, None, total_ms, config.subtitleArea.value)
                        self.subtitle_ocr_task_queue.put(task)
                    last_total_ms = total_ms
                    if total_ms / duration_ms >= 1:
                        self.update_progress(frame_extract=100)
                        return
                    else:
                        self.update_progress(frame_extract=(total_ms / duration_ms) * 100)
                else:
                    self.append_output(line.strip())
            out.close()

        # Linux only
        path_vsf = os.path.join(BASE_DIR, "subfinder", "linux", "VideoSubFinderCli.run")
        path_vsf_cli = os.path.join(BASE_DIR, "subfinder", "linux", "VideoSubFinderCli")
        if not os.path.exists(path_vsf):
            raise FileNotFoundError(f"VSF launcher not found: {path_vsf}")
        if not os.path.isfile(path_vsf_cli):
            raise FileNotFoundError(
                f"VSF binary missing: {path_vsf_cli}. "
                "Copy VideoSubFinderCli from video-subtitle-extractor Linux release "
                "into vse/subfinder/linux/ and run: chmod +x VideoSubFinderCli VideoSubFinderCli.run"
            )

        top_end = 1 - self.sub_area.ymin / self.frame_height
        bottom_end = 1 - self.sub_area.ymax / self.frame_height
        left_end = self.sub_area.xmin / self.frame_width
        right_end = self.sub_area.xmax / self.frame_width
        cpu_count = max(multiprocessing.cpu_count() - 2, 1)
        if config.videoSubFinderCpuCores.value > 0:
            cpu_count = config.videoSubFinderCpuCores.value

        cmd = f'{path_vsf} -c -r -i "{self.video_path}" -o "{self.temp_output_dir}" -ces "{self.vsf_subtitle}" '
        if self.hardware_accelerator.has_accelerator():
            cmd += "--use_cuda "
        cmd += f"-te {top_end} -be {bottom_end} -le {left_end} -re {right_end} -nthr {cpu_count} -dsi "
        cmd += f"--open_video_{config.videoSubFinderDecoder.value.value.lower()} "

        self.vsf_running = True
        try:
            p = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=-1,
                close_fds=True,
                shell=True,
                start_new_session=True,
            )
            threading.Thread(target=vsf_output, daemon=True, args=(p.stderr,)).start()
            ProcessManager.instance().add_process(p)
            return_code = p.wait()
            if return_code != 0:
                raise RuntimeError(
                    f"VideoSubFinder exited with code {return_code}. "
                    "On WSL, use a Linux-native binary and avoid /mnt/c paths; "
                    "or run with --vse-mode accurate (GPU). "
                    "Ensure VideoSubFinderCli is executable (chmod as deploy user, chown for node)."
                )
            if not os.path.isfile(self.vsf_subtitle):
                raise RuntimeError(
                    f"VideoSubFinder did not create {self.vsf_subtitle}. "
                    "VSF may have crashed (segfault) — check ldd/file on VideoSubFinderCli."
                )
        finally:
            self.vsf_running = False

    def _generate_subtitle_file(self):
        """Generate SRT from raw.txt (non-VSF path)."""
        subtitle_content = self._remove_duplicate_subtitle()
        with open(self.subtitle_output_path, mode="w", encoding="utf-8") as f:
            for index, content in enumerate(subtitle_content):
                line_code = index + 1
                frame_start = self._frame_to_timecode(int(content[0]))
                if abs(int(content[1]) - int(content[0])) < self.fps:
                    frame_end = self._frame_to_timecode(int(int(content[0]) + self.fps))
                else:
                    frame_end = self._frame_to_timecode(int(content[1]))
                frame_content = content[2]
                subtitle_line = f"{line_code}\n{frame_start} --> {frame_end}\n{frame_content}\n"
                f.write(subtitle_line)
        self.append_output(f"[Done] Subtitle file location: {self.subtitle_output_path}")

    def _generate_subtitle_file_vsf(self):
        """Generate SRT from VSF timing + OCR text."""
        if not self.use_vsf:
            return
        subs = pysrt.open(self.vsf_subtitle)
        sub_no_map = {}
        for sub in subs:
            sub.start.no = self._timestamp_to_frameno(sub.start.ordinal)
            sub_no_map[sub.start.no] = sub

        subtitle_content = self._remove_duplicate_subtitle()
        subtitle_content_start_map = {int(a[0]): a for a in subtitle_content}
        final_subtitles = []
        for sub in subs:
            found = sub.start.no in subtitle_content_start_map
            if found:
                subtitle_content_line = subtitle_content_start_map[sub.start.no]
                sub.text = subtitle_content_line[2]
                end_no = int(subtitle_content_line[1])
                sub.end = sub_no_map[end_no].end if end_no in sub_no_map else sub.end
                sub.index = len(final_subtitles) + 1
                final_subtitles.append(sub)

            if not found and not config.deleteEmptyTimeStamp.value:
                sub.text = ""
                sub.index = len(final_subtitles) + 1
                final_subtitles.append(sub)

        pysrt.SubRipFile(final_subtitles).save(self.subtitle_output_path, encoding="utf-8")
        self.append_output(f"[Done] Subtitle file location: {self.subtitle_output_path}")

    def _frame_to_timecode(self, frame_no):
        total_ms = frame_no / self.fps * 1000
        total_ms_int = int(total_ms)
        milliseconds = total_ms_int % 1000
        total_seconds = total_ms_int // 1000
        seconds = total_seconds % 60
        minutes = (total_seconds // 60) % 60
        hours = total_seconds // 3600
        return "%02d:%02d:%02d,%03d" % (hours, minutes, seconds, milliseconds)

    def _timestamp_to_frameno(self, time_ms):
        return int(time_ms / self.fps)

    def _remove_duplicate_subtitle(self):
        """Remove duplicate subtitle lines using Levenshtein distance."""
        self._concat_content_with_same_frameno()
        with open(self.raw_subtitle_path, mode="r", encoding="utf-8") as r:
            lines = r.readlines()
        RawInfo = namedtuple("RawInfo", "no content")
        content_list = []
        for line in lines:
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            frame_no = parts[0]
            content = parts[2]
            content_list.append(RawInfo(frame_no, content))

        unique_subtitle_list = []
        idx_i = 0
        content_list_len = len(content_list)
        while idx_i < content_list_len:
            i = content_list[idx_i]
            start_frame = i.no
            idx_j = idx_i
            while idx_j < content_list_len:
                if idx_j + 1 == content_list_len or ratio(
                    i.content.replace(" ", ""), content_list[idx_j + 1].content.replace(" ", "")
                ) < (config.thresholdTextSimilarity.value / 100.0):
                    end_frame = content_list[idx_j].no
                    similar_list = content_list[idx_i : idx_j + 1]
                    similar_content_strip_list = [item.content.replace(" ", "") for item in similar_list]
                    index, _ = max(enumerate(similar_content_strip_list), key=lambda x: len(x[1]))
                    unique_subtitle_list.append((start_frame, end_frame, similar_list[index].content))
                    idx_i = idx_j + 1
                    break
                else:
                    idx_j += 1
        return unique_subtitle_list

    def _concat_content_with_same_frameno(self):
        """Merge OCR results from same frame."""
        with open(self.raw_subtitle_path, mode="r", encoding="utf-8") as f:
            lines = f.readlines()
        frame_content_map = {}
        for line in lines:
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            frame_no = parts[0]
            content = parts[2].strip()
            if frame_no in frame_content_map:
                frame_content_map[frame_no] += " " + content
            else:
                frame_content_map[frame_no] = content
        with open(self.raw_subtitle_path, mode="w", encoding="utf-8") as f:
            for frame_no, content in frame_content_map.items():
                f.write(f"{frame_no}\t(0, 0, 0, 0)\t{content}\n")

    def _get_area_text(self, ocr_result):
        dt_box, rec_res = ocr_result
        return [r[0] for r in rec_res]

    def _compare_ocr_result(self, cache, _, start_frame_no, frame, current_frame_no):
        if start_frame_no not in cache:
            return True
        area_text1 = cache[start_frame_no]["text"]
        dt_box, rec_res = self.ocr.predict(frame)
        area_text2 = "".join(self._get_area_text((dt_box, rec_res)))
        cache[current_frame_no] = {"text": area_text2, "dt_box": dt_box, "rec_res": rec_res}
        return ratio(area_text1, area_text2) > config.thresholdTextSimilarity.value / 100.0
