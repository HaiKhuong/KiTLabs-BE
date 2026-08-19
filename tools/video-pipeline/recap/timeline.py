from __future__ import annotations

import logging
from typing import Any

LOG = logging.getLogger("recap.timeline")

# Adaptive fit: voice ngắn / B-roll dài → tăng tốc clip (trên base videoSpeed).
MAX_ADAPTIVE_CLIP_SPEED = 4.0


def _tts_audio_duration(tts: dict[str, Any]) -> float:
    raw = tts.get("audioDur")
    if raw is None:
        raw = tts.get("durationSec")
    try:
        return max(0.0, float(raw or 0))
    except (TypeError, ValueError):
        return 0.0


def _fit_video_cues_to_voice(
    video_cues: list[dict[str, Any]],
    audio_dur: float,
    voice_t0: float,
    base_speed: float,
) -> list[dict[str, Any]]:
    """When packed B-roll exceeds narration, speed up clips instead of hard-trimming."""
    if not video_cues or audio_dur <= 0.05:
        return video_cues

    total_v = sum(float(v["t1"]) - float(v["t0"]) for v in video_cues)
    if total_v <= audio_dur + 0.05:
        for v in video_cues:
            v.setdefault("speed", round(base_speed, 4))
        return video_cues

    fit_mult = total_v / audio_dur
    eff_speed = min(MAX_ADAPTIVE_CLIP_SPEED, max(base_speed, base_speed * fit_mult))
    LOG.info(
        "Voice-fit cue @%.1fs: video %.2fs > voice %.2fs → clip speed %.2fx (base %.2fx)",
        voice_t0,
        total_v,
        audio_dur,
        eff_speed,
        base_speed,
    )

    rebuilt: list[dict[str, Any]] = []
    t_local = 0.0
    for v in video_cues:
        if t_local >= audio_dur - 0.01:
            break
        src_in = float(v["srcIn"])
        src_out = float(v["srcOut"])
        src_span = max(0.05, src_out - src_in)
        out_dur = min(src_span / eff_speed, max(0.05, audio_dur - t_local))
        src_span = out_dur * eff_speed
        rebuilt.append(
            {
                "shot": int(v["shot"]),
                "t0": round(voice_t0 + t_local, 3),
                "t1": round(voice_t0 + t_local + out_dur, 3),
                "srcIn": round(src_in, 3),
                "srcOut": round(src_in + src_span, 3),
                "speed": round(eff_speed, 4),
            }
        )
        t_local += out_dur

    # Max speed vẫn không đủ → cắt bớt clip cuối (fallback hiếm).
    total_fit = sum(float(v["t1"]) - float(v["t0"]) for v in rebuilt)
    if total_fit > audio_dur + 0.05 and rebuilt:
        overflow = total_fit - audio_dur
        last = rebuilt[-1]
        span = float(last["t1"]) - float(last["t0"])
        cut = min(overflow, max(0.0, span - 0.05))
        last["t1"] = round(float(last["t1"]) - cut, 3)
        clip_speed = float(last.get("speed") or eff_speed)
        last["srcOut"] = round(float(last["srcOut"]) - cut * clip_speed, 3)
        LOG.warning(
            "Voice-fit still overflow %.2fs after max speed %.2fx — trimmed tail",
            overflow,
            eff_speed,
        )

    return rebuilt


def pack_voice_master_timeline(
    shots: list[dict[str, Any]],
    picks: list[list[int]],
    candidates: list[list[int]],
    tts_meta: list[dict[str, Any]],
    video_speed: float = 1.0,
) -> dict[str, Any]:
    speed = max(0.5, min(2.0, float(video_speed or 1.0)))
    by_id = {int(s["id"]): s for s in shots}
    cues: list[dict[str, Any]] = []
    cursor = 0.0

    for i, tts in enumerate(tts_meta):
        audio_dur = _tts_audio_duration(tts)
        if audio_dur <= 0.05:
            LOG.warning("TTS seg %d missing audio duration — skip cue", i)
            continue
        voice_t0 = cursor
        voice_t1 = cursor + audio_dur
        shot_ids = list(picks[i]) if i < len(picks) else []
        cand = list(candidates[i]) if i < len(candidates) else []

        video_cues: list[dict[str, Any]] = []
        remain = audio_dur
        t_local = 0.0
        used = set()

        def append_shot(sid: int) -> bool:
            nonlocal remain, t_local
            s = by_id.get(sid)
            if not s:
                return False
            natural = max(0.05, float(s["endSec"]) - float(s["startSec"]))
            # Faster B-roll: consume more source per output second (speed > 1).
            max_out = natural / speed
            take = min(max_out, remain)
            if take <= 0.01:
                return False
            src_in = float(s["startSec"])
            src_out = src_in + take * speed
            video_cues.append(
                {
                    "shot": sid,
                    "t0": round(voice_t0 + t_local, 3),
                    "t1": round(voice_t0 + t_local + take, 3),
                    "srcIn": round(src_in, 3),
                    "srcOut": round(src_out, 3),
                }
            )
            t_local += take
            remain -= take
            used.add(sid)
            return True

        for sid in shot_ids:
            if remain <= 0.05:
                break
            append_shot(int(sid))

        # fill from remaining shortlist
        for sid in cand:
            if remain <= 0.05:
                break
            if int(sid) in used:
                continue
            append_shot(int(sid))

        # Voice ngắn / video dài → tăng tốc B-roll; voice dài / video ngắn → freeze frame cuối.
        if remain > 0.05 and video_cues:
            last = video_cues[-1]
            last["t1"] = round(float(last["t1"]) + remain, 3)
            # Giữ frame cuối (không kéo thêm source).
            remain = 0.0
        elif remain > 0.05 and shots:
            # no picks at all — use first shot freeze
            s0 = shots[0]
            video_cues.append(
                {
                    "shot": int(s0["id"]),
                    "t0": round(voice_t0, 3),
                    "t1": round(voice_t1, 3),
                    "srcIn": float(s0["startSec"]),
                    "srcOut": round(float(s0["startSec"]) + min(audio_dur * speed, 0.5), 3),
                    "speed": round(speed, 4),
                }
            )

        video_cues = _fit_video_cues_to_voice(video_cues, audio_dur, voice_t0, speed)

        cues.append(
            {
                "i": i,
                "voice": {
                    "t0": round(voice_t0, 3),
                    "t1": round(voice_t1, 3),
                    "file": tts["file"],
                },
                "video": video_cues,
            }
        )
        cursor = voice_t1

    return {"voiceMaster": True, "videoSpeed": speed, "cues": cues, "durationSec": round(cursor, 3)}
