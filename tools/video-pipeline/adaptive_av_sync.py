"""
Adaptive Audio-Video Speed & Duration Sync (2-Tier Architecture)
cho hệ thống tự động thuyết minh phim (Auto-Dubbing Pipeline).

Chiến lược xử lý 2 tầng:
- Tầng 1 (Audio Optimization):
    1. Nén khoảng lặng nội tại (Internal Silence Compression: > 0.25s -> 0.12s kèm crossfade 10ms).
    2. Tính required_speed = compressed_audio_duration / available_duration.
    3. Nếu required_speed <= SAFE_AUDIO_SPEED_MAX (1.20): dùng pyrubberband hoặc FFmpeg atempo
       (giữ nguyên cao độ Pitch) khớp chính xác available_duration. Không can thiệp vào video.
- Tầng 2 (Video Time-Stretching & Global Timeline Shift):
    Áp dụng khi required_speed > 1.20:
    1. Khóa tốc độ Audio ở mức trần an toàn 1.20x (hoặc bù nhẹ nếu video chạm trần giãn 1.35x).
    2. Kéo giãn đoạn video gốc [start_time, end_time] với hệ số video_stretch_factor <= 1.35.
    3. Cộng dồn độ lệch Δt = final_audio_dur - available_duration vào toàn bộ các segment
       phía sau (i+1 .. N) để đồng bộ tuyệt đối đến cuối phim.
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import shutil
import subprocess
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, List, Literal, Optional, Sequence, Tuple

import numpy as np
import soundfile as sf

# ---------------------------------------------------------------------------
# Cấu hình mặc định (Thresholds & Constants)
# ---------------------------------------------------------------------------

SAFE_AUDIO_SPEED_MAX: float = 1.20
MAX_VIDEO_STRETCH_FACTOR: float = 1.35
DEFAULT_SAMPLE_RATE: int = 48000

INTERNAL_SILENCE_MIN_SEC: float = 0.25
INTERNAL_SILENCE_TARGET_SEC: float = 0.12
SILENCE_THRESHOLD_DB: float = -40.0
CROSSFADE_MS: float = 10.0

logger = logging.getLogger("adaptive_av_sync")
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s", "%H:%M:%S")
    )
    logger.addHandler(_handler)
    logger.setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Data Models
# ---------------------------------------------------------------------------


@dataclass
class DubbingSegment:
    """Metadata của một câu thoại TTS gắn với khung thời gian SRT."""

    index: int
    start_time: float  # Giây (trên timeline video gốc)
    end_time: float  # Giây (trên timeline video gốc)
    text: str
    audio_path: str
    audio_duration: float = 0.0  # Thời lượng file TTS thô (giây)
    available_duration: float = 0.0  # Thời lượng cho phép (đã gồm gap mượn thêm nếu có)

    # Kết quả sau khi qua 2 tầng đồng bộ
    compressed_duration: float = 0.0
    processed_audio_path: str = ""
    shifted_start_time: float = 0.0
    shifted_end_time: float = 0.0
    final_audio_duration: float = 0.0
    applied_audio_speed: float = 1.0
    video_stretch_factor: float = 1.0
    delta_t: float = 0.0
    tier_used: str = "NATIVE_FIT"


@dataclass
class StretchInterval:
    """Khoảng thời gian trên video gốc cần kéo giãn khung hình (Tầng 2)."""

    segment_index: int
    orig_start: float
    orig_end: float
    stretch_factor: float
    delta_t: float

    @property
    def orig_duration(self) -> float:
        return max(0.0, self.orig_end - self.orig_start)

    @property
    def stretched_duration(self) -> float:
        return self.orig_duration * self.stretch_factor


@dataclass
class SyncReport:
    """Báo cáo tổng hợp sau khi đồng bộ toàn bộ timeline."""

    total_segments: int = 0
    native_fit_count: int = 0
    tier1_silence_only_count: int = 0
    tier1_atempo_count: int = 0
    tier2_video_stretch_count: int = 0
    total_video_added_sec: float = 0.0
    original_video_duration_sec: float = 0.0
    final_video_duration_sec: float = 0.0
    master_audio_path: str = ""
    synced_srt_path: str = ""
    stretch_intervals: List[StretchInterval] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Class 1: AudioOptimizer (Tầng 1 - Tối ưu khoảng lặng & Tốc độ Audio)
# ---------------------------------------------------------------------------


class AudioOptimizer:
    """
    Xử lý Tầng 1:
    1. Nén khoảng lặng nội tại (Internal Silence Compression: > 0.25s -> 0.12s).
    2. Tăng tốc Audio giữ nguyên Pitch bằng pyrubberband hoặc FFmpeg atempo.
    """

    def __init__(
        self,
        *,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        safe_speed_max: float = SAFE_AUDIO_SPEED_MAX,
        internal_silence_min_sec: float = INTERNAL_SILENCE_MIN_SEC,
        internal_silence_target_sec: float = INTERNAL_SILENCE_TARGET_SEC,
        silence_threshold_db: float = SILENCE_THRESHOLD_DB,
        ffmpeg_bin: str = "ffmpeg",
    ) -> None:
        self.sample_rate = int(sample_rate)
        self.safe_speed_max = float(safe_speed_max)
        self.internal_silence_min_sec = float(internal_silence_min_sec)
        self.internal_silence_target_sec = float(internal_silence_target_sec)
        self.silence_threshold_db = float(silence_threshold_db)
        self.ffmpeg_bin = ffmpeg_bin

    @staticmethod
    def probe_audio_duration(audio_path: str | Path) -> float:
        """Đọc chính xác thời lượng file âm thanh (giây)."""
        p = Path(audio_path)
        if not p.is_file() or p.stat().st_size <= 44:
            return 0.0
        try:
            info = sf.info(str(p))
            if info.frames > 0 and info.samplerate > 0:
                return float(info.frames) / float(info.samplerate)
        except Exception:
            pass
        return 0.0

    def _read_mono_resampled(self, audio_path: str | Path) -> np.ndarray:
        """Đọc WAV về mảng float32 1-D ở đúng sample_rate mục tiêu."""
        waves, sr = sf.read(str(audio_path), dtype="float32", always_2d=True)
        mono = waves.mean(axis=1)
        if sr != self.sample_rate and mono.size > 0:
            try:
                import torchaudio.functional as AF
                import torch

                tensor = torch.from_numpy(mono).unsqueeze(0)
                mono = AF.resample(tensor, sr, self.sample_rate).squeeze(0).numpy()
            except Exception:
                # Nội suy tuyến tính nhanh nếu không gọi được torchaudio
                duration = mono.size / float(sr)
                target_len = max(1, int(round(duration * self.sample_rate)))
                x_old = np.linspace(0.0, 1.0, mono.size, endpoint=False)
                x_new = np.linspace(0.0, 1.0, target_len, endpoint=False)
                mono = np.interp(x_new, x_old, mono).astype(np.float32)
        return mono

    def compress_internal_silence(
        self,
        in_wav: str | Path,
        out_wav: str | Path,
        *,
        head_keep_sec: float = 0.025,
        tail_keep_sec: float = 0.035,
    ) -> float:
        """
        Quét và rút ngắn các khoảng nghỉ nội tại (> 0.25s -> 0.12s) + cắt khoảng lặng thừa
        ở 2 đầu câu để giảm thời lượng tự nhiên mà vẫn giữ nguyên tốc độ phát âm 1.0x.

        Trả về thời lượng mới (giây) của file `out_wav`.
        """
        samples = self._read_mono_resampled(in_wav)
        if samples.size == 0:
            sf.write(str(out_wav), np.zeros(int(self.sample_rate * 0.05), dtype=np.float32), self.sample_rate, subtype="PCM_16")
            return 0.05

        frame_ms = 10
        frame_len = max(1, int(self.sample_rate * frame_ms / 1000))
        num_frames = samples.size // frame_len
        if num_frames <= 4:
            sf.write(str(out_wav), samples, self.sample_rate, subtype="PCM_16")
            return float(samples.size) / self.sample_rate

        framed = samples[: num_frames * frame_len].reshape(num_frames, frame_len)
        rms = np.sqrt(np.mean(np.square(framed), axis=1) + 1e-12)
        db = 20.0 * np.log10(rms)
        is_silent = db < self.silence_threshold_db

        voiced_indices = np.where(~is_silent)[0]
        if voiced_indices.size == 0:
            sf.write(str(out_wav), samples, self.sample_rate, subtype="PCM_16")
            return float(samples.size) / self.sample_rate

        first_voiced = int(voiced_indices[0])
        last_voiced = int(voiced_indices[-1])

        head_frames = max(0, int(round(head_keep_sec * 1000 / frame_ms)))
        tail_frames = max(0, int(round(tail_keep_sec * 1000 / frame_ms)))
        start_f = max(0, first_voiced - head_frames)
        end_f = min(num_frames, last_voiced + 1 + tail_frames)

        min_sil_frames = max(1, int(round(self.internal_silence_min_sec * 1000 / frame_ms)))
        target_sil_frames = max(1, int(round(self.internal_silence_target_sec * 1000 / frame_ms)))
        fade_samples = max(8, int(self.sample_rate * (CROSSFADE_MS / 1000.0)))

        pieces: List[np.ndarray] = []
        idx = start_f
        while idx < end_f:
            if not is_silent[idx]:
                nxt = idx + 1
                while nxt < end_f and not is_silent[nxt]:
                    nxt += 1
                chunk = samples[idx * frame_len : nxt * frame_len].copy()
                pieces.append(chunk)
                idx = nxt
            else:
                nxt = idx + 1
                while nxt < end_f and is_silent[nxt]:
                    nxt += 1
                sil_f = nxt - idx
                keep_f = target_sil_frames if sil_f >= min_sil_frames else sil_f
                keep_samples = keep_f * frame_len
                raw_sil = samples[idx * frame_len : nxt * frame_len]
                if raw_sil.size > keep_samples and keep_samples > 2 * fade_samples:
                    # Giữ nửa đầu + nửa cuối của khoảng lặng kèm crossfade mượt
                    half = keep_samples // 2
                    left = raw_sil[: half + fade_samples].copy()
                    right = raw_sil[-(keep_samples - half) :].copy()
                    alpha = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
                    left[-fade_samples:] = (
                        left[-fade_samples:] * (1.0 - alpha) + right[:fade_samples] * alpha
                    )
                    compressed_sil = np.concatenate([left, right[fade_samples:]])
                    pieces.append(compressed_sil)
                else:
                    pieces.append(raw_sil[:keep_samples].copy())
                idx = nxt

        out_samples = np.concatenate(pieces) if pieces else samples
        Path(out_wav).parent.mkdir(parents=True, exist_ok=True)
        sf.write(str(out_wav), out_samples, self.sample_rate, subtype="PCM_16")
        return float(out_samples.size) / float(self.sample_rate)

    @staticmethod
    def build_atempo_filter_chain(speed: float) -> str:
        """
        Xây dựng chuỗi filter `atempo` của FFmpeg (mỗi mắt xích trong [0.5, 2.0]).
        """
        s = max(0.25, min(float(speed), 8.0))
        if abs(s - 1.0) <= 1e-4:
            return "atempo=1.0"
        parts: List[str] = []
        while s > 2.0 + 1e-6:
            parts.append("atempo=2.0")
            s /= 2.0
        while s < 0.5 - 1e-6:
            parts.append("atempo=0.5")
            s /= 0.5
        parts.append(f"atempo={s:.6f}")
        return ",".join(parts)

    def time_stretch_audio(
        self,
        in_wav: str | Path,
        out_wav: str | Path,
        *,
        speed_factor: float,
        target_duration_sec: float,
    ) -> float:
        """
        Tăng/giảm tốc độ file WAV giữ nguyên cao độ (Pitch-Preserving) và chuẩn hóa
        chính xác về `target_duration_sec` ở `self.sample_rate`.
        Ưu tiên `pyrubberband` nếu có, ngược lại dùng FFmpeg `atempo`.
        """
        Path(out_wav).parent.mkdir(parents=True, exist_ok=True)
        target_samples = max(1, int(round(target_duration_sec * self.sample_rate)))

        # Nhánh 1: Nếu không cần tăng tốc (speed_factor ~ 1.0), chỉ cần pad/trim nhẹ
        if abs(speed_factor - 1.0) <= 0.008:
            samples = self._read_mono_resampled(in_wav)
            fitted = self._fit_exact_samples(samples, target_samples)
            sf.write(str(out_wav), fitted, self.sample_rate, subtype="PCM_16")
            return float(target_samples) / float(self.sample_rate)

        # Nhánh 2: Thử dùng pyrubberband nếu môi trường đã cài đặt
        try:
            import pyrubberband as pyrb  # type: ignore

            samples = self._read_mono_resampled(in_wav)
            stretched = pyrb.time_stretch(samples, self.sample_rate, float(speed_factor))
            fitted = self._fit_exact_samples(np.asarray(stretched, dtype=np.float32), target_samples)
            sf.write(str(out_wav), fitted, self.sample_rate, subtype="PCM_16")
            return float(target_samples) / float(self.sample_rate)
        except Exception:
            pass

        # Nhánh 3: Dùng FFmpeg filter `atempo` + `apad` + `atrim` + `afade`
        atempo_chain = self.build_atempo_filter_chain(speed_factor)
        fade_d = min(0.025, max(0.005, target_duration_sec * 0.08))
        fade_st = max(0.0, target_duration_sec - fade_d)
        af_chain = (
            f"{atempo_chain},"
            f"aresample={self.sample_rate},"
            f"apad=pad_dur={target_duration_sec:.4f},"
            f"atrim=duration={target_duration_sec:.4f},"
            f"afade=t=out:st={fade_st:.4f}:d={fade_d:.4f}"
        )
        cmd = [
            self.ffmpeg_bin,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(in_wav),
            "-af",
            af_chain,
            "-ac",
            "1",
            "-ar",
            str(self.sample_rate),
            "-c:a",
            "pcm_s16le",
            str(out_wav),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            raise RuntimeError(
                f"FFmpeg atempo failed for {in_wav}: {(proc.stderr or proc.stdout).strip()}"
            )

        # Đảm bảo khớp chính xác tới từng sample
        samples = self._read_mono_resampled(out_wav)
        if samples.size != target_samples:
            fitted = self._fit_exact_samples(samples, target_samples)
            sf.write(str(out_wav), fitted, self.sample_rate, subtype="PCM_16")
        return float(target_samples) / float(self.sample_rate)

    def _fit_exact_samples(self, samples: np.ndarray, target_samples: int) -> np.ndarray:
        """Pad khoảng lặng hoặc cắt kèm fade-out nhẹ để khớp đúng số lượng sample."""
        if samples.size == target_samples:
            return samples
        if samples.size < target_samples:
            pad = np.zeros(target_samples - samples.size, dtype=np.float32)
            return np.concatenate([samples, pad])
        trimmed = samples[:target_samples].copy()
        fade_len = min(int(self.sample_rate * 0.015), target_samples // 4)
        if fade_len > 1:
            trimmed[-fade_len:] *= np.linspace(1.0, 0.0, fade_len, dtype=np.float32)
        return trimmed


# ---------------------------------------------------------------------------
# Class 2: TimelineSynchronizer (Phân tầng 1 & 2 + Master Audio Builder)
# ---------------------------------------------------------------------------


class TimelineSynchronizer:
    """
    Điều phối xử lý phân tầng (Tầng 1 & Tầng 2), cập nhật độ lệch toàn cục (Timeline Shift)
    và ghép file `master_dubbed_audio.wav` duy nhất.
    """

    def __init__(
        self,
        optimizer: AudioOptimizer,
        *,
        safe_audio_speed_max: float = SAFE_AUDIO_SPEED_MAX,
        max_video_stretch_factor: float = MAX_VIDEO_STRETCH_FACTOR,
        borrow_gap_enabled: bool = True,
        min_gap_keep_sec: float = 0.05,
    ) -> None:
        self.optimizer = optimizer
        self.safe_audio_speed_max = float(safe_audio_speed_max)
        self.max_video_stretch_factor = float(max_video_stretch_factor)
        self.borrow_gap_enabled = bool(borrow_gap_enabled)
        self.min_gap_keep_sec = float(min_gap_keep_sec)

    def synchronize_segments(
        self,
        segments: Sequence[DubbingSegment],
        work_dir: str | Path,
        *,
        original_video_duration_sec: float,
    ) -> Tuple[List[DubbingSegment], SyncReport]:
        """
        Chạy phân tích & xử lý 2 tầng trên toàn bộ danh sách câu thoại.
        Cập nhật `shifted_start_time`, `shifted_end_time` và danh sách `stretch_intervals`.
        """
        work_path = Path(work_dir)
        compressed_dir = work_path / "compressed_wavs"
        processed_dir = work_path / "processed_wavs"
        compressed_dir.mkdir(parents=True, exist_ok=True)
        processed_dir.mkdir(parents=True, exist_ok=True)

        sorted_segs = [
             DubbingSegment(**asdict(s))
            for s in sorted(segments, key=lambda x: (x.start_time, x.index))
        ]
        n = len(sorted_segs)

        report = SyncReport(
            total_segments=n,
            original_video_duration_sec=float(original_video_duration_sec),
        )

        cumulative_offset = 0.0

        for i, seg in enumerate(sorted_segs):
            if seg.audio_duration <= 0.0:
                seg.audio_duration = self.optimizer.probe_audio_duration(seg.audio_path)

            base_slot = max(0.05, float(seg.end_time - seg.start_time))

            # Tính available_duration (có thể mượn khoảng trống trước câu tiếp theo nếu chưa truyền sẵn)
            if seg.available_duration <= 0.0:
                if self.borrow_gap_enabled and i + 1 < n:
                    next_start = float(sorted_segs[i + 1].start_time)
                    borrowable = max(0.0, (next_start - seg.end_time) - self.min_gap_keep_sec)
                    seg.available_duration = base_slot + borrowable
                else:
                    seg.available_duration = base_slot

            avail_dur = max(0.05, float(seg.available_duration))
            # Nếu mượn gap phía sau thì đoạn video tương ứng được phép phủ tới start_time + avail_dur
            effective_orig_end = min(
                float(original_video_duration_sec),
                float(seg.start_time) + avail_dur,
            )
            avail_dur = max(0.05, effective_orig_end - float(seg.start_time))
            seg.available_duration = avail_dur

            out_seg_wav = processed_dir / f"seg_{seg.index:05d}.wav"

            # ------------------------------------------------------------------
            # Trường hợp 0: Audio gốc đã ngắn hơn hoặc bằng available_duration
            # ------------------------------------------------------------------
            if seg.audio_duration <= avail_dur + 1e-3:
                seg.compressed_duration = seg.audio_duration
                seg.applied_audio_speed = 1.0
                seg.video_stretch_factor = 1.0
                seg.delta_t = 0.0
                seg.tier_used = "NATIVE_FIT"
                seg.final_audio_duration = self.optimizer.time_stretch_audio(
                    seg.audio_path,
                    out_seg_wav,
                    speed_factor=1.0,
                    target_duration_sec= seg.audio_duration,
                )
                seg.processed_audio_path = str(out_seg_wav)
                seg.shifted_start_time = seg.start_time + cumulative_offset
                seg.shifted_end_time = seg.shifted_start_time + seg.final_audio_duration
                report.native_fit_count += 1
                continue

            # ------------------------------------------------------------------
            # TẦNG 1: Nén khoảng lặng nội tại + Tăng tốc Audio <= 1.20x
            # ------------------------------------------------------------------
            comp_wav = compressed_dir / f"comp_{seg.index:05d}.wav"
            comp_dur = self.optimizer.compress_internal_silence(seg.audio_path, comp_wav)
            seg.compressed_duration = comp_dur

            required_speed = comp_dur / avail_dur

            if required_speed <= 1.005:
                # Chỉ cần nén khoảng lặng nội tại đã đủ vừa khít!
                seg.applied_audio_speed = 1.0
                seg.video_stretch_factor = 1.0
                seg.delta_t = 0.0
                seg.tier_used = "TIER1_SILENCE_COMPRESSION"
                seg.final_audio_duration = self.optimizer.time_stretch_audio(
                    comp_wav,
                    out_seg_wav,
                    speed_factor=1.0,
                    target_duration_sec=min(comp_dur, avail_dur),
                )
                seg.processed_audio_path = str(out_seg_wav)
                seg.shifted_start_time = seg.start_time + cumulative_offset
                seg.shifted_end_time = seg.shifted_start_time + seg.final_audio_duration
                report.tier1_silence_only_count += 1
                continue

            if required_speed <= self.safe_audio_speed_max + 1e-6:
                # Tầng 1: atempo trong ngưỡng tự nhiên (<= 1.20x), không đụng vào video
                seg.applied_audio_speed = required_speed
                seg.video_stretch_factor = 1.0
                seg.delta_t = 0.0
                seg.tier_used = "TIER1_AUDIO_ATEMPO"
                seg.final_audio_duration = self.optimizer.time_stretch_audio(
                    comp_wav,
                    out_seg_wav,
                    speed_factor=required_speed,
                    target_duration_sec=avail_dur,
                )
                seg.processed_audio_path = str(out_seg_wav)
                seg.shifted_start_time = seg.start_time + cumulative_offset
                seg.shifted_end_time = seg.shifted_start_time + seg.final_audio_duration
                report.tier1_atempo_count += 1
                continue

            # ------------------------------------------------------------------
            # TẦNG 2: Kéo giãn khung hình Video (Video Time-Stretching) & Dịch Timeline
            # ------------------------------------------------------------------
            ideal_audio_dur = comp_dur / self.safe_audio_speed_max
            raw_video_stretch = ideal_audio_dur / avail_dur
            video_stretch = min(self.max_video_stretch_factor, max(1.0, raw_video_stretch))

            # Độ dài mới của đoạn video sau khi kéo giãn
            stretched_slot_dur = avail_dur * video_stretch
            # Nếu chạm trần giãn video 1.35x thì audio bù nhẹ phần dư để khớp tuyệt đối 100%
            actual_audio_speed = comp_dur / stretched_slot_dur

            seg.applied_audio_speed = actual_audio_speed
            seg.video_stretch_factor = video_stretch
            seg.tier_used = "TIER2_VIDEO_STRETCH"
            seg.final_audio_duration = self.optimizer.time_stretch_audio(
                comp_wav,
                out_seg_wav,
                speed_factor=actual_audio_speed,
                target_duration_sec=stretched_slot_dur,
            )
            seg.processed_audio_path = str(out_seg_wav)

            delta_t = stretched_slot_dur - avail_dur
            seg.delta_t = delta_t
            seg.shifted_start_time = seg.start_time + cumulative_offset
            seg.shifted_end_time = seg.shifted_start_time + seg.final_audio_duration

            report.tier2_video_stretch_count += 1
            report.total_video_added_sec += delta_t
            report.stretch_intervals.append(
                StretchInterval(
                    segment_index=seg.index,
                    orig_start=float(seg.start_time),
                    orig_end=float(effective_orig_end),
                    stretch_factor=float(video_stretch),
                    delta_t=float(delta_t),
                )
            )

            # Cộng dồn Δt cho toàn bộ các segment phía sau (i+1 .. N)
            cumulative_offset += delta_t

        report.final_video_duration_sec = (
            report.original_video_duration_sec + report.total_video_added_sec
        )
        return sorted_segs, report

    def build_master_audio_track(
        self,
        synced_segments: Sequence[DubbingSegment],
        output_wav_path: str | Path,
        *,
        total_duration_sec: float,
    ) -> Path:
        """
        Ghép toàn bộ các file `.wav` đã xử lý kèm khoảng lặng `silence` dựa trên timeline mới
        đã cập nhật offset thành 1 file `master_dubbed_audio.wav` duy nhất (streaming O(1) RAM).
        """
        out_path = Path(output_wav_path).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        sr = self.optimizer.sample_rate
        total_target_samples = max(1, int(round(total_duration_sec * sr)))

        written_samples = 0
        zero_chunk_size = sr * 10  # Buffer 10s khi ghi silence

        def _write_zeros(snd_file: sf.SoundFile, count: int) -> None:
            rem = count
            while rem > 0:
                step = min(rem, zero_chunk_size)
                snd_file.write(np.zeros(step, dtype=np.float32))
                rem -= step

        with sf.SoundFile(
            str(out_path),
            mode="w",
            samplerate=sr,
            channels=1,
            subtype="PCM_16",
        ) as out_f:
            for seg in synced_segments:
                seg_start_sample = max(0, int(round(seg.shifted_start_time * sr)))
                if seg_start_sample > written_samples:
                    gap_samples = seg_start_sample - written_samples
                    _write_zeros(out_f, gap_samples)
                    written_samples += gap_samples

                wav_data = self.optimizer._read_mono_resampled(seg.processed_audio_path)
                if seg_start_sample < written_samples:
                    # Phòng vệ nếu có chồng lấp vài mẫu do làm tròn số thực
                    overlap = written_samples - seg_start_sample
                    wav_data = wav_data[overlap:] if overlap < wav_data.size else np.zeros(0, dtype=np.float32)

                if wav_data.size > 0:
                    out_f.write(wav_data)
                    written_samples += int(wav_data.size)

            if total_target_samples > written_samples:
                _write_zeros(out_f, total_target_samples - written_samples)

        return out_path

    @staticmethod
    def _format_srt_timestamp(seconds: float) -> str:
        ms_total = max(0, int(round(seconds * 1000.0)))
        hh = ms_total // 3_600_000
        mm = (ms_total % 3_600_000) // 60_000
        ss = (ms_total % 60_000) // 1_000
        ms = ms_total % 1_000
        return f"{hh:02d}:{mm:02d}:{ss:02d},{ms:03d}"

    def export_synced_srt(
        self,
        synced_segments: Sequence[DubbingSegment],
        output_srt_path: str | Path,
    ) -> Path:
        """Xuất file phụ đề `.srt` mới khớp với Timeline đã dịch chuyển offset Δt."""
        srt_path = Path(output_srt_path).resolve()
        srt_path.parent.mkdir(parents=True, exist_ok=True)
        lines: List[str] = []
        for idx, seg in enumerate(synced_segments, start=1):
            t0 = self._format_srt_timestamp(seg.shifted_start_time)
            t1 = self._format_srt_timestamp(seg.shifted_end_time)
            lines.append(f"{idx}\n{t0} --> {t1}\n{seg.text.strip()}\n")
        srt_path.write_text("\n".join(lines), encoding="utf-8")
        return srt_path


# ---------------------------------------------------------------------------
# Class 3: FFmpegRenderer (Single-Pass NVENC Hardware Rendering)
# ---------------------------------------------------------------------------


class FFmpegRenderer:
    """
    Render video trong 1 lệnh FFmpeg duy nhất (Single-Pass Rendering):
    - Sinh kịch bản `filter_complex` ra file `.txt` và truyền qua `-filter_complex_script`
      để tránh giới hạn độ dài command line trên Windows/Linux.
    - Hỗ trợ 2 chế độ kéo giãn khung hình:
        + `trim_concat`: dùng `trim` + `setpts` + `concat` (chuẩn xác từng phân đoạn).
        + `setpts_expr`: dùng biểu thức toán học `setpts` liên tục từng khúc trên 1 luồng
          video duy nhất (O(1) RAM cho video 60 phút có hàng trăm điểm giãn).
    - Tăng tốc phần cứng GPU NVIDIA: `-c:v h264_nvenc -preset p4 -cq 23`.
    """

    def __init__(
        self,
        *,
        ffmpeg_bin: str = "ffmpeg",
        ffprobe_bin: str = "ffprobe",
        nvenc_preset: str = "p4",
        nvenc_cq: int = 23,
        original_audio_volume: float = 0.0,
        dubbed_audio_volume: float = 1.0,
        filter_mode: Literal["auto", "trim_concat", "setpts_expr"] = "auto",
    ) -> None:
        self.ffmpeg_bin = ffmpeg_bin
        self.ffprobe_bin = ffprobe_bin
        self.nvenc_preset = nvenc_preset
        self.nvenc_cq = int(nvenc_cq)
        self.original_audio_volume = float(original_audio_volume)
        self.dubbed_audio_volume = float(dubbed_audio_volume)
        self.filter_mode = filter_mode

    def probe_video_info(self, video_path: str | Path) -> dict[str, Any]:
        """Đọc duration, fps và kiểm tra audio stream của video gốc bằng ffprobe."""
        cmd = [
            self.ffprobe_bin,
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=index,codec_type,r_frame_rate,width,height",
            "-of",
            "json",
            str(video_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(proc.stdout or "{}")
        streams = data.get("streams") or []
        v_stream = next((s for s in streams if s.get("codec_type") == "video"), {})
        has_audio = any(s.get("codec_type") == "audio" for s in streams)

        fps_raw = str(v_stream.get("r_frame_rate") or "30/1")
        try:
            if "/" in fps_raw:
                num, den = fps_raw.split("/", 1)
                fps = float(num) / max(1.0, float(den))
            else:
                fps = float(fps_raw)
        except Exception:
            fps = 30.0

        dur = float((data.get("format") or {}).get("duration") or 0.0)
        return {
            "duration": dur,
            "fps": fps,
            "has_audio": has_audio,
            "width": int(v_stream.get("width") or 1920),
            "height": int(v_stream.get("height") or 1080),
        }

    def supports_nvenc(self) -> bool:
        """Kiểm tra FFmpeg hiện tại có hỗ trợ encoder `h264_nvenc` hay không."""
        try:
            proc = subprocess.run(
                [self.ffmpeg_bin, "-hide_banner", "-encoders"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            return "h264_nvenc" in (proc.stdout or "")
        except Exception:
            return False

    def filter_complex_script_flag(self) -> str:
        """
        Tự động phát hiện cờ nạp file filter_complex theo phiên bản FFmpeg:
        - FFmpeg <= 6.x: `-filter_complex_script <file>`
        - FFmpeg >= 7.x / 8.x / 9.x: `-/filter_complex <file>` (cú pháp đọc option từ file mới)
        """
        try:
            proc = subprocess.run(
                [self.ffmpeg_bin, "-hide_banner", "-h", "long"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            help_out = (proc.stdout or "") + (proc.stderr or "")
            if "filter_complex_script" in help_out:
                return "-filter_complex_script"
        except Exception:
            pass
        return "-/filter_complex"

    @staticmethod
    def _normalize_stretch_intervals(
        intervals: Sequence[StretchInterval],
        video_duration: float,
    ) -> List[StretchInterval]:
        """Đảm bảo các khoảng giãn nằm trong [0, video_duration] và không chồng lấp."""
        cleaned: List[StretchInterval] = []
        cursor = 0.0
        for iv in sorted(intervals, key=lambda x: x.orig_start):
            s = max(cursor, float(iv.orig_start))
            e = min(float(video_duration), float(iv.orig_end))
            if e - s < 0.02 or iv.stretch_factor <= 1.001:
                continue
            cleaned.append(
                StretchInterval(
                    segment_index=iv.segment_index,
                    orig_start=s,
                    orig_end=e,
                    stretch_factor=float(iv.stretch_factor),
                    delta_t=(e - s) * (float(iv.stretch_factor) - 1.0),
                )
            )
            cursor = e
        return cleaned

    def _build_trim_concat_video_filter(
        self,
        intervals: Sequence[StretchInterval],
        video_duration: float,
    ) -> Tuple[List[str], str]:
        """
        Sinh chuỗi filter `[0:v]trim=...,setpts=...[v0]; ... concat=n=K:v=1:a=0[vout]`.
        """
        slices: List[Tuple[float, float, float]] = []
        cursor = 0.0
        for iv in intervals:
            if iv.orig_start > cursor + 0.005:
                slices.append((cursor, iv.orig_start, 1.0))
            slices.append((iv.orig_start, iv.orig_end, iv.stretch_factor))
            cursor = iv.orig_end
        if video_duration > cursor + 0.005:
            slices.append((cursor, video_duration, 1.0))

        if not slices:
            return ["[0:v]null[vout]"], "[vout]"

        fc_lines: List[str] = []
        labels: List[str] = []
        for idx, (s, e, factor) in enumerate(slices):
            lbl = f"[v{idx}]"
            labels.append(lbl)
            if abs(factor - 1.0) <= 1e-4:
                fc_lines.append(
                    f"[0:v]trim=start={s:.4f}:end={e:.4f},setpts=PTS-STARTPTS{lbl}"
                )
            else:
                fc_lines.append(
                    f"[0:v]trim=start={s:.4f}:end={e:.4f},setpts={factor:.6f}*(PTS-STARTPTS){lbl}"
                )

        if len(labels) == 1:
            fc_lines.append(f"{labels[0]}null[vout]")
        else:
            fc_lines.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0[vout]")
        return fc_lines, "[vout]"

    def _build_piecewise_setpts_video_filter(
        self,
        intervals: Sequence[StretchInterval],
        fps: float,
    ) -> Tuple[List[str], str]:
        """
        Sinh biểu thức `setpts` liên tục từng khúc trên 1 luồng `[0:v]` duy nhất.
        Ưu điểm: O(1) RAM ngay cả khi video 60 phút có > 150 điểm giãn thời gian.
        Công thức:
            t'(T) = T + sum_k clip((T - s_k), 0, e_k - s_k) * (factor_k - 1)
        Vì clip(T - s, 0, d) = max(0, min(T - s, d)), tổng này liên tục tuyệt đối trên toàn trục T!
        """
        if not intervals:
            return ["[0:v]null[vout]"], "[vout]"

        terms: List[str] = ["T"]
        for iv in intervals:
            dur = iv.orig_end - iv.orig_start
            extra_rate = iv.stretch_factor - 1.0
            if dur > 0.001 and extra_rate > 1e-4:
                terms.append(
                    f"{extra_rate:.6f}*max(0\\,min(T-{iv.orig_start:.4f}\\,{dur:.4f}))"
                )

        expr = "+".join(terms)
        safe_fps = max(15.0, min(120.0, float(fps or 30.0)))
        line = f"[0:v]setpts='({expr})/TB',fps={safe_fps:.3f}[vout]"
        return [line], "[vout]"

    def generate_filter_complex_script(
        self,
        *,
        video_duration: float,
        fps: float,
        stretch_intervals: Sequence[StretchInterval],
        script_path: str | Path,
        has_original_audio: bool = False,
    ) -> Tuple[Path, str, str]:
        """
        Tạo file kịch bản `filter_complex_script.txt` cho FFmpeg.
        Trả về `(script_path, video_out_label, audio_out_label)`.
        """
        norm_intervals = self._normalize_stretch_intervals(
            stretch_intervals, video_duration
        )

        # Tự chọn mode: nếu <= 40 điểm giãn thì dùng trim+concat, nếu > 40 điểm dùng setpts_expr
        mode = self.filter_mode
        if mode == "auto":
            mode = "trim_concat" if len(norm_intervals) <= 40 else "setpts_expr"

        if mode == "trim_concat":
            fc_lines, v_label = self._build_trim_concat_video_filter(
                norm_intervals, video_duration
            )
        else:
            fc_lines, v_label = self._build_piecewise_setpts_video_filter(
                norm_intervals, fps
            )

        # Xử lý Audio: Input [1:a] là master_dubbed_audio.wav đã khớp 100% timeline mới
        if has_original_audio and self.original_audio_volume > 1e-4:
            # Nếu muốn giữ nhạc nền gốc nhỏ phía dưới, kéo giãn [0:a] đồng bộ với tổng thời lượng mới
            total_stretch = (
                (video_duration + sum(iv.delta_t for iv in norm_intervals))
                / max(0.1, video_duration)
            )
            bg_atempo = AudioOptimizer.build_atempo_filter_chain(1.0 / total_stretch)
            fc_lines.append(
                f"[0:a]{bg_atempo},volume={self.original_audio_volume:.4f}[abg]"
            )
            fc_lines.append(f"[1:a]volume={self.dubbed_audio_volume:.4f}[adub]")
            fc_lines.append(
                "[abg][adub]amix=inputs=2:duration=longest:dropout_transition=0[aout]"
            )
            a_label = "[aout]"
        else:
            fc_lines.append(f"[1:a]volume={self.dubbed_audio_volume:.4f}[aout]")
            a_label = "[aout]"

        out_script = Path(script_path).resolve()
        out_script.parent.mkdir(parents=True, exist_ok=True)
        out_script.write_text(";\n".join(fc_lines) + "\n", encoding="utf-8")
        return out_script, v_label, a_label

    def render(
        self,
        *,
        input_video: str | Path,
        master_audio: str | Path,
        output_video: str | Path,
        stretch_intervals: Sequence[StretchInterval],
        filter_script_path: Optional[str | Path] = None,
    ) -> Path:
        """
        Thực thi lệnh FFmpeg Single-Pass duy nhất kết hợp `filter_complex_script` và `h264_nvenc`.
        """
        in_vid = Path(input_video).resolve()
        in_aud = Path(master_audio).resolve()
        out_vid = Path(output_video).resolve()

        if not in_vid.is_file():
            raise FileNotFoundError(f"Input video not found: {in_vid}")
        if not in_aud.is_file():
            raise FileNotFoundError(f"Master dubbed audio not found: {in_aud}")

        out_vid.parent.mkdir(parents=True, exist_ok=True)
        v_info = self.probe_video_info(in_vid)

        script_file = (
            Path(filter_script_path).resolve()
            if filter_script_path
            else out_vid.with_suffix(".filter_complex.txt")
        )
        script_file, v_label, a_label = self.generate_filter_complex_script(
            video_duration=v_info["duration"],
            fps=v_info["fps"],
            stretch_intervals=stretch_intervals,
            script_path=script_file,
            has_original_audio=v_info["has_audio"],
        )

        use_nvenc = self.supports_nvenc()
        script_flag = self.filter_complex_script_flag()
        video_codec_args = (
            [
                "-c:v",
                "h264_nvenc",
                "-preset",
                self.nvenc_preset,
                "-cq",
                str(self.nvenc_cq),
                "-pix_fmt",
                "yuv420p",
            ]
            if use_nvenc
            else [
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                str(self.nvenc_cq),
                "-pix_fmt",
                "yuv420p",
            ]
        )

        cmd = [
            self.ffmpeg_bin,
            "-y",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-i",
            str(in_vid),
            "-i",
            str(in_aud),
            script_flag,
            str(script_file),
            "-map",
            v_label,
            "-map",
            a_label,
            *video_codec_args,
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            str(DEFAULT_SAMPLE_RATE),
            "-movflags",
            "+faststart",
            str(out_vid),
        ]

        logger.info(
            "FFmpeg Single-Pass Render (%s) | stretch_intervals=%d | %s=%s",
            "h264_nvenc" if use_nvenc else "libx264 (fallback)",
            len(stretch_intervals),
            script_flag,
            script_file.name,
        )
        t0 = time.perf_counter()
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0 and use_nvenc:
            logger.warning(
                "h264_nvenc failed (%s); falling back to libx264...",
                (proc.stderr or "").strip()[:300],
            )
            fallback_cmd = [
                self.ffmpeg_bin,
                "-y",
                "-hide_banner",
                "-loglevel",
                "warning",
                "-i",
                str(in_vid),
                "-i",
                str(in_aud),
                script_flag,
                str(script_file),
                "-map",
                v_label,
                "-map",
                a_label,
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                str(self.nvenc_cq),
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-ar",
                str(DEFAULT_SAMPLE_RATE),
                "-movflags",
                "+faststart",
                str(out_vid),
            ]
            proc = subprocess.run(fallback_cmd, capture_output=True, text=True, check=False)

        if proc.returncode != 0:
            raise RuntimeError(
                f"FFmpeg render failed (exit {proc.returncode}):\n{(proc.stderr or proc.stdout).strip()}"
            )

        elapsed = time.perf_counter() - t0
        logger.info("Render hoàn tất sau %.2fs -> %s", elapsed, out_vid)
        return out_vid


# ---------------------------------------------------------------------------
# High-Level Pipeline Runner & Demo
# ---------------------------------------------------------------------------


def run_adaptive_dubbing_pipeline(
    *,
    input_video: str | Path,
    segments: Sequence[DubbingSegment],
    output_video: str | Path,
    work_dir: str | Path,
    safe_audio_speed_max: float = SAFE_AUDIO_SPEED_MAX,
    max_video_stretch_factor: float = MAX_VIDEO_STRETCH_FACTOR,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    original_audio_volume: float = 0.0,
    dubbed_audio_volume: float = 1.0,
) -> SyncReport:
    """
    Hàm tích hợp trọn gói:
    1. Tối ưu từng segment theo chiến lược 2 tầng (`AudioOptimizer` + `TimelineSynchronizer`).
    2. Xuất `master_dubbed_audio.wav` và `synced_subtitles.srt`.
    3. Render video 1-pass bằng `FFmpegRenderer` (`h264_nvenc` + `-filter_complex_script`).
    """
    work_path = Path(work_dir).resolve()
    work_path.mkdir(parents=True, exist_ok=True)

    optimizer = AudioOptimizer(
        sample_rate=sample_rate,
        safe_speed_max=safe_audio_speed_max,
    )
    synchronizer = TimelineSynchronizer(
        optimizer,
        safe_audio_speed_max=safe_audio_speed_max,
        max_video_stretch_factor=max_video_stretch_factor,
    )
    renderer = FFmpegRenderer(
        original_audio_volume=original_audio_volume,
        dubbed_audio_volume=dubbed_audio_volume,
    )

    v_info = renderer.probe_video_info(input_video)
    orig_dur = v_info["duration"]
    logger.info(
        "Bắt đầu đồng bộ %d câu thoại | Video gốc: %.2fs (%dx%d @ %.2ffps)",
        len(segments),
        orig_dur,
        v_info["width"],
        v_info["height"],
        v_info["fps"],
    )

    synced_segs, report = synchronizer.synchronize_segments(
        segments,
        work_path,
        original_video_duration_sec=orig_dur,
    )

    master_wav = work_path / "master_dubbed_audio.wav"
    synchronizer.build_master_audio_track(
        synced_segs,
        master_wav,
        total_duration_sec=report.final_video_duration_sec,
    )
    report.master_audio_path = str(master_wav)

    synced_srt = work_path / "synced_subtitles.srt"
    synchronizer.export_synced_srt(synced_segs, synced_srt)
    report.synced_srt_path = str(synced_srt)

    logger.info(
        "=== THỐNG KÊ ĐỒNG BỘ 2 TẦNG ===\n"
        "  - Tổng số câu thoại              : %d\n"
        "  - Vừa khít tự nhiên (1.0x)       : %d\n"
        "  - Tầng 1 (Chỉ nén khoảng lặng)   : %d\n"
        "  - Tầng 1 (Atempo <= %.2fx)       : %d\n"
        "  - Tầng 2 (Kéo giãn Video <= %.2fx): %d\n"
        "  - Tổng thời gian Video giãn thêm : +%.2fs (%.2fs -> %.2fs)",
        report.total_segments,
        report.native_fit_count,
        report.tier1_silence_only_count,
         safe_audio_speed_max,
        report.tier1_atempo_count,
        max_video_stretch_factor,
        report.tier2_video_stretch_count,
        report.total_video_added_sec,
        report.original_video_duration_sec,
        report.final_video_duration_sec,
    )

    renderer.render(
        input_video=input_video,
        master_audio=master_wav,
        output_video=output_video,
        stretch_intervals=report.stretch_intervals,
        filter_script_path=work_path / "filter_complex_script.txt",
    )
    return report


# ---------------------------------------------------------------------------
# Ví dụ chạy thử hoàn chỉnh (Self-Contained Demo)
# ---------------------------------------------------------------------------


def _generate_synthetic_speech_wav(
    path: Path,
    *,
    total_duration_sec: float,
    internal_pause_sec: float = 0.0,
    sample_rate: int = DEFAULT_SAMPLE_RATE,
) -> float:
    """Tạo file WAV 48kHz giả lập giọng nói có khoảng nghỉ nội tại để kiểm thử."""
    t_total = int(round(total_duration_sec * sample_rate))
    pause_samples = int(round(internal_pause_sec * sample_rate))
    voiced_samples = max(1, t_total - pause_samples)
    half_v = voiced_samples // 2

    t1 = np.linspace(0.0, half_v / sample_rate, half_v, endpoint=False)
    t2 = np.linspace(0.0, (voiced_samples - half_v) / sample_rate, voiced_samples - half_v, endpoint=False)
    part1 = 0.25 * np.sin(2.0 * np.pi * 220.0 * t1).astype(np.float32)
    pause = np.zeros(pause_samples, dtype=np.float32)
    part2 = 0.25 * np.sin(2.0 * np.pi * 260.0 * t2).astype(np.float32)

    wave = np.concatenate([part1, pause, part2])
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), wave, sample_rate, subtype="PCM_16")
    return float(wave.size) / float(sample_rate)


def run_self_test_demo() -> None:
    """Chạy thử toàn bộ pipeline trên dữ liệu giả lập (Video 1080p + 4 câu thoại đủ mọi kịch bản)."""
    with tempfile.TemporaryDirectory(prefix="adaptive_av_demo_") as tmp:
        tmp_dir = Path(tmp)
        mock_video = tmp_dir / "input_video.mp4"
        out_video = tmp_dir / "output_dubbed.mp4"
        work_dir = tmp_dir / "work"

        # 1. Tạo video 1080p 12 giây bằng FFmpeg testsrc
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=12:size=1920x1080:rate=30",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=12:sample_rate=48000",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                str(mock_video),
            ],
            check=True,
        )

        # 2. Tạo 4 segment WAV 48kHz đại diện cho các trường hợp thực tế:
        # - Seg 1 (0.5s -> 2.0s, slot 1.5s): TTS dài 1.3s -> Vừa khít (NATIVE_FIT)
        # - Seg 2 (2.5s -> 4.5s, slot 2.0s): TTS dài 2.45s nhưng có 0.6s nghỉ giữa câu -> Nén khoảng lặng còn ~2.07s + atempo 1.035x (TIER 1)
        # - Seg 3 (5.0s -> 7.0s, slot 2.0s): TTS dài 2.30s không có nghỉ dài -> Atempo 1.15x <= 1.20x (TIER 1)
        # - Seg 4 (7.5s -> 9.5s, slot 2.0s): TTS rất dài 3.10s -> Vượt 1.20x -> Khóa atempo ~1.20x + Kéo giãn Video ~1.29x + Dịch timeline (TIER 2)
        seg1_wav = tmp_dir / "raw_1.wav"
        seg2_wav = tmp_dir / "raw_2.wav"
        seg3_wav = tmp_dir / "raw_3.wav"
        seg4_wav = tmp_dir / "raw_4.wav"

        d1 = _generate_synthetic_speech_wav(seg1_wav, total_duration_sec=1.30, internal_pause_sec=0.0)
        d2 = _generate_synthetic_speech_wav(seg2_wav, total_duration_sec=2.45, internal_pause_sec=0.60)
        d3 = _generate_synthetic_speech_wav(seg3_wav, total_duration_sec=2.30, internal_pause_sec=0.0)
        d4 = _generate_synthetic_speech_wav(seg4_wav, total_duration_sec=3.10, internal_pause_sec=0.0)

        demo_segments = [
            DubbingSegment(1, 0.50, 2.00, "Câu 1 vừa khít thời lượng gốc.", str(seg1_wav), d1, 1.50),
            DubbingSegment(2, 2.50, 4.50, "Câu 2 có khoảng nghỉ nội tại dài, xử lý ở Tầng 1.", str(seg2_wav), d2, 2.00),
            DubbingSegment(3, 5.00, 7.00, "Câu 3 hơi dài, tăng tốc nhẹ 1.15x ở Tầng 1.", str(seg3_wav), d3, 2.00),
            DubbingSegment(4, 7.50, 9.50, "Câu 4 dịch từ tiếng Trung rất dài, kích hoạt Tầng 2 kéo giãn video.", str(seg4_wav), d4, 2.00),
        ]

        report = run_adaptive_dubbing_pipeline(
            input_video=mock_video,
            segments=demo_segments,
            output_video=out_video,
            work_dir=work_dir,
            original_audio_volume=0.10,
            dubbed_audio_volume=1.00,
        )

        logger.info("File filter_complex_script.txt sinh ra:\n%s", (work_dir / "filter_complex_script.txt").read_text(encoding="utf-8"))
        logger.info("Demo hoàn tất! Thời lượng video đầu ra: %.2fs", report.final_video_duration_sec)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Adaptive Audio-Video Speed & Duration Sync")
    parser.add_argument("--demo", action="store_true", help="Chạy kịch bản kiểm thử tự động (Self-Test Demo)")
    parser.add_argument("--video", type=str, help="Đường dẫn input_video.mp4")
    parser.add_argument("--segments-json", type=str, help="Đường dẫn file JSON chứa danh sách segment")
    parser.add_argument("--output", type=str, help="Đường dẫn video đầu ra")
    parser.add_argument("--work-dir", type=str, default="./av_sync_work", help="Thư mục tạm chứa WAV và script")
    args = parser.parse_args()

    if args.demo or not args.video:
        run_self_test_demo()
    else:
        raw_list = json.loads(Path(args.segments_json).read_text(encoding="utf-8"))
        seg_objs = [DubbingSegment(**item) for item in raw_list]
        run_adaptive_dubbing_pipeline(
            input_video=args.video,
            segments=seg_objs,
            output_video=args.output,
            work_dir=args.work_dir,
        )
