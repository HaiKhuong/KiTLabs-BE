from __future__ import annotations

import logging
from typing import Any

LOG = logging.getLogger("recap.timeline")


def pack_voice_master_timeline(
    shots: list[dict[str, Any]],
    picks: list[list[int]],
    candidates: list[list[int]],
    tts_meta: list[dict[str, Any]],
) -> dict[str, Any]:
    by_id = {int(s["id"]): s for s in shots}
    cues: list[dict[str, Any]] = []
    cursor = 0.0

    for i, tts in enumerate(tts_meta):
        audio_dur = float(tts["audioDur"])
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
            take = min(natural, remain)
            if take <= 0.01:
                return False
            src_in = float(s["startSec"])
            src_out = src_in + take
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

        # freeze/extend last shot if still short
        if remain > 0.05 and video_cues:
            last = video_cues[-1]
            last["t1"] = round(last["t1"] + remain, 3)
            last["srcOut"] = round(last["srcOut"] + remain, 3)
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
                    "srcOut": float(s0["startSec"]) + audio_dur,
                }
            )

        # trim overflow
        total_v = sum(v["t1"] - v["t0"] for v in video_cues)
        if total_v > audio_dur + 0.05 and video_cues:
            overflow = total_v - audio_dur
            last = video_cues[-1]
            span = last["t1"] - last["t0"]
            cut = min(overflow, max(0.0, span - 0.05))
            last["t1"] = round(last["t1"] - cut, 3)
            last["srcOut"] = round(last["srcOut"] - cut, 3)

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

    return {"voiceMaster": True, "cues": cues, "durationSec": round(cursor, 3)}
