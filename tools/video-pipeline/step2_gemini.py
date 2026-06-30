"""
Step 2: Gemini translate (zh -> vi) for subtitle batches.

Gọi configure_step2_gemini(...) trước khi dùng step2_translate_srt.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Callable, List, Optional

from google import genai

_cfg: dict[str, Any] = {}

# Các cụm noise/laugh — dùng cho 2 việc:
# 1) Block chỉ còn đúng một cụm → bỏ hẳn khỏi vi.srt (giữ nguyên id các block khác).
# 2) Cụm xuất hiện trong câu dài (vd. "HAHA xin chào") → xóa cụm, giữ phần còn lại.
# Thứ tự trong tuple không quan trọng; khi replace luôn ưu tiên cụm dài trước.
STEP2_VI_SKIP_TEXTS: tuple[str, ...] = (
    "HAHA",
    "HAHAHA",
    "HAHAHAHAHA",
    "HA HA",
    "HA HA HA",
    "Haiz",
    "hừ hừ",
    "Hừ",
    "Hừ!",
    "A!",
    "A !",
    "A.",
    "Ừm",
    "Ừm!",
    "Hừm",
    "Hì hì.",
    "Ồ.",
    "Khụ khụ.",
    "Á!",
    "Á.",
    "Ư...",
    "Ư.",
    "Ư!",
    "Xì!",
    "Xì.",
)

# Gemini clients initialized after configure
_gemini_api_keys: List[str] = []
_gemini_clients: List[genai.Client] = []
_active_key_index: int = 0


def _parse_api_keys(raw_value: Optional[str]) -> List[str]:
    if not raw_value:
        return []
    parts = [p.strip() for p in re.split(r"[,\n;]+", str(raw_value)) if p and str(p).strip()]
    return list(dict.fromkeys(parts))


def get_gemini_api_key_pools_from_env() -> tuple[List[str], List[str]]:
    """standard = GEMINI_API_KEY + GOOGLE_API_KEY; vip = GEMINI_API_KEY_VIP."""
    standard: List[str] = []
    standard.extend(_parse_api_keys(os.environ.get("GEMINI_API_KEY")))
    standard.extend(_parse_api_keys(os.environ.get("GOOGLE_API_KEY")))
    standard = list(dict.fromkeys(standard))
    vip = list(dict.fromkeys(_parse_api_keys(os.environ.get("GEMINI_API_KEY_VIP"))))
    return standard, vip


def resolve_gemini_api_keys_for_tier(tier: str) -> List[str]:
    standard, vip = get_gemini_api_key_pools_from_env()
    tier_norm = str(tier or "standard").strip().lower()
    if tier_norm == "vip":
        if not vip:
            raise RuntimeError(
                "Missing Gemini VIP API key. Set GEMINI_API_KEY_VIP in .env or the environment."
            )
        return vip
    if not standard:
        raise RuntimeError(
            "Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_API_KEY in .env or the environment."
        )
    return standard


def configure_step2_gemini(
    *,
    log: Callable[[str], None],
    write_text: Callable[[Path, str], None],
    append_text: Callable[[Path, str], None],
    parse_srt: Callable[[str], List[dict]],
    write_srt: Callable[[List[dict], Path], None],
    progressbar: Callable,
    retry_call: Callable,
    get_vi_srt_path: Callable[[], Path],
    log_dir: Path,
    gemini_api_keys: Optional[List[str]] = None,
    gemini_key_tier: str = "standard",
    gemini_model_name: str,
    gemini_retry_max: int,
    translate_batch_size: int,
    translation_context: str,
    step2_multi_keys_enabled: bool,
    step2_vi_skip_texts_enabled: bool = False,
) -> None:
    global _gemini_api_keys, _gemini_clients, _active_key_index

    tier_norm = str(gemini_key_tier or "standard").strip().lower()
    if tier_norm not in {"standard", "vip"}:
        tier_norm = "standard"
    resolved_keys = list(gemini_api_keys or []) or resolve_gemini_api_keys_for_tier(tier_norm)

    _cfg.clear()
    _cfg.update(
        log=log,
        write_text=write_text,
        append_text=append_text,
        parse_srt=parse_srt,
        write_srt=write_srt,
        progressbar=progressbar,
        retry_call=retry_call,
        get_vi_srt_path=get_vi_srt_path,
        log_dir=Path(log_dir),
        gemini_key_tier=tier_norm,
        gemini_model_name=str(gemini_model_name or ""),
        gemini_retry_max=int(gemini_retry_max),
        translate_batch_size=int(translate_batch_size),
        translation_context=str(translation_context or ""),
        step2_multi_keys_enabled=bool(step2_multi_keys_enabled),
        step2_vi_skip_texts_enabled=bool(step2_vi_skip_texts_enabled),
    )

    _gemini_api_keys = resolved_keys
    _gemini_clients = [genai.Client(api_key=key) for key in _gemini_api_keys]
    _active_key_index = 0


def _mask_secret(secret, show_prefix=4, show_suffix=4):
    raw = str(secret or "")
    if not raw:
        return ""
    if len(raw) <= show_prefix + show_suffix:
        return "*" * len(raw)
    return f"{raw[:show_prefix]}***{raw[-show_suffix:]}"


def _extract_json_array(text):
    cleaned = text.strip()
    match = re.search(r"\[.*\]", cleaned, flags=re.DOTALL)
    if not match:
        raise ValueError("No JSON array found in model output.")
    return json.loads(match.group(0))


def _parse_line_format(text: str) -> dict[int, str]:
    """Parse output format: '0:|text' or '0:|vi: text' per line."""
    result = {}
    for line in text.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        match = re.match(r"^(\d+):\|(.*)$", line)
        if match:
            idx = int(match.group(1))
            content = match.group(2).strip()
            # Strip 'vi:' or 'vi：' prefix if present
            content = re.sub(r"^vi\s*[:：]\s*", "", content, flags=re.IGNORECASE)
            result[idx] = content
    return result


def _validate_batch_mapping(mapped: dict[int, str], expected_count: int) -> None:
    missing = [i for i in range(expected_count) if i not in mapped]
    if missing:
        raise ValueError(
            f"Gemini line count mismatch: got {len(mapped)}/{expected_count} lines; "
            f"missing ids: {missing}"
        )
    empty = [i for i in range(expected_count) if not str(mapped[i]).strip()]
    if empty:
        raise ValueError(f"Gemini returned empty translation for ids: {empty}")


def _normalize_batch_mapping(
    mapped: dict[int, str],
    batch: list,
    batch_start_index: int,
) -> dict[int, str]:
    """Map Gemini ids back to local batch indices 0..n-1."""
    expected_count = len(batch)
    if expected_count == 0:
        return {}

    def complete(local_map: dict[int, str]) -> bool:
        return all(i in local_map and str(local_map[i]).strip() for i in range(expected_count))

    if complete(mapped):
        return {i: mapped[i] for i in range(expected_count)}

    offset_map = {k - batch_start_index: v for k, v in mapped.items()}
    if complete(offset_map):
        return {i: offset_map[i] for i in range(expected_count)}

    block_to_local = {int(b["index"]): i for i, b in enumerate(batch)}
    block_map: dict[int, str] = {}
    for key, value in mapped.items():
        local_idx = block_to_local.get(int(key))
        if local_idx is not None:
            block_map[local_idx] = value
    if complete(block_map):
        return {i: block_map[i] for i in range(expected_count)}

    got_ids = sorted(mapped.keys())
    raise ValueError(
        f"Gemini line count mismatch: expected {expected_count} lines (ids 0..{expected_count - 1}), "
        f"got ids {got_ids}"
    )


def _build_translate_prompt(batch: list, payload_text: str, translation_context: str) -> str:
    line_count = len(batch)
    last_id = line_count - 1
    prompt_parts = [
        "Translate Chinese subtitles into Vietnamese.\n",
        "Write very concise, subtitle-friendly Vietnamese.\n",
        "Keep original meaning and emotional tone, but simplify phrasing.\n",
        "Preserve historical tone, titles, names, and relationships.\n",
    ]

    if translation_context and translation_context.strip():
        prompt_parts.append(f"{translation_context.strip()}\n")
    else:
        prompt_parts.append("Han-Viet terms OK. Historical/wuxia context.\n")

    prompt_parts.append(
        f"INPUT: exactly {line_count} lines (ids 0 to {last_id}):\n"
        f"{payload_text}\n\n"
        "OUTPUT RULES (mandatory):\n"
        f"- Return exactly {line_count} lines with ids 0 to {last_id}, same order as input.\n"
        "- Translate each input line separately into exactly one output line.\n"
        "- Do NOT merge, split, skip, deduplicate, summarize, or reorder lines.\n"
        "- Do NOT combine short consecutive lines into one translation.\n"
        "- Format each output line: id:|Vietnamese translation\n"
        "- Output ONLY translated lines. No notes, no markdown, no extra text.\n"
    )
    return "".join(prompt_parts)


def _parse_response(text: str) -> dict[int, str]:
    """Try JSON first, fallback to line format."""
    try:
        data = _extract_json_array(text)
        mapped = {}
        for item in data:
            idx = int(item["id"])
            mapped[idx] = str(item["vi"]).strip()
        return mapped
    except (ValueError, KeyError, json.JSONDecodeError):
        pass

    mapped = _parse_line_format(text)
    if mapped:
        return mapped

    raise ValueError(f"Cannot parse response (not JSON or line format): {text[:200]}")


def _normalize_skip_text(text: str) -> str:
    """Gom khoảng trắng thừa."""
    return " ".join(str(text or "").strip().split())


def _keyword_to_remove_pattern(keyword: str) -> str:
    """Regex xóa keyword khỏi câu (không partial trong từ khác)."""
    parts = keyword.split()
    if len(parts) > 1:
        core = r"\s+".join(rf"\b{re.escape(p)}\b" for p in parts)
        return rf"(?i){core}"
    core = re.escape(keyword)
    # Keyword kết thúc bằng dấu câu (A!, Hừ!, …): \b sau ! không khớp cuối chuỗi / trước space.
    trailing = r"(?!\w)" if re.search(r"\W$", keyword) else r"\b"
    return rf"(?i)\b{core}{trailing}"


def _trim_orphan_edge_punctuation(text: str) -> str:
    """Xóa dấu câu thừa ở đầu sau khi gỡ keyword (vd. ', ở đây...!' → 'ở đây...!')."""
    t = str(text or "")
    return re.sub(r"^[\s,.!?;:'\"…\-—、，。！？]+", "", t)


def _strip_vi_noise_keywords(text: str) -> str:
    """Xóa các keyword noise khỏi text; trả về chuỗi đã chuẩn hóa khoảng trắng."""
    t = str(text or "")
    for keyword in sorted(STEP2_VI_SKIP_TEXTS, key=len, reverse=True):
        t = re.sub(_keyword_to_remove_pattern(keyword), "", t)
    t = _normalize_skip_text(t)
    t = _trim_orphan_edge_punctuation(t)
    return _normalize_skip_text(t)


def _has_substantive_vi_text(text: str) -> bool:
    """False nếu rỗng hoặc chỉ còn dấu câu / khoảng trắng (sau khi gỡ keyword)."""
    norm = _normalize_skip_text(text)
    if not norm:
        return False
    return bool(re.search(r"[\w]", norm, flags=re.UNICODE))


def translate_batch_with_gemini(batch, batch_start_index):
    global _active_key_index

    log = _cfg["log"]
    write_text = _cfg["write_text"]
    append_text = _cfg["append_text"]
    retry_call = _cfg["retry_call"]
    log_dir = _cfg["log_dir"]
    gemini_model_name = _cfg["gemini_model_name"]
    gemini_retry_max = _cfg["gemini_retry_max"]
    translation_context = _cfg["translation_context"]
    step2_multi_keys_enabled = _cfg["step2_multi_keys_enabled"]

    payload_lines = [f"{i}:|{b['text']}" for i, b in enumerate(batch)]
    payload_text = "\n".join(payload_lines)
    prompt = _build_translate_prompt(batch, payload_text, translation_context)

    debug_dir = log_dir / "gemini_debug"
    debug_dir.mkdir(parents=True, exist_ok=True)
    batch_name = f"batch_{batch_start_index:06d}"
    request_path = debug_dir / f"{batch_name}_request.txt"
    response_path = debug_dir / f"{batch_name}_response.txt"
    request_content = (
        f"model: {gemini_model_name}\n"
        f"batch_start_index: {batch_start_index}\n"
        f"batch_size: {len(batch)}\n\n"
        f"prompt:\n{prompt}\n"
    )
    write_text(request_path, request_content)

    attempt_no = 0

    def _is_token_limit_error(exc):
        text = str(exc or "").lower()
        return any(
            key in text
            for key in (
                "token",
                "quota",
                "resource_exhausted",
                "rate limit",
                "too many requests",
                "429",
            )
        )

    def _is_high_demand_error(exc):
        text = str(exc or "").lower()
        return any(
            key in text
            for key in (
                "high demand",
                "overloaded",
                "service unavailable",
                "unavailable",
                "temporarily unavailable",
                "503",
            )
        )

    def _call():
        global _active_key_index
        nonlocal attempt_no
        total_key_count = len(_gemini_clients)
        if total_key_count == 0:
            raise RuntimeError("No Gemini API keys available.")
        key_count = total_key_count if step2_multi_keys_enabled else 1
        start_idx = _active_key_index % total_key_count
        last_error = None

        for offset in range(key_count):
            key_idx = (start_idx + offset) % total_key_count
            key_masked = _mask_secret(_gemini_api_keys[key_idx])
            attempt_no += 1
            try:
                response = _gemini_clients[key_idx].models.generate_content(
                    model=gemini_model_name,
                    contents=prompt,
                )
                raw_text = response.text or ""
                append_text(
                    response_path,
                    (
                        f"===== attempt {attempt_no} | key {key_idx + 1}/{total_key_count} "
                        f"({key_masked}) | {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n"
                        f"{raw_text}\n\n"
                    ),
                )
                parsed = _parse_response(raw_text)
                mapped = _normalize_batch_mapping(parsed, batch, batch_start_index)
                _validate_batch_mapping(mapped, len(batch))
                _active_key_index = key_idx
                return mapped
            except Exception as e:
                last_error = e
                append_text(
                    response_path,
                    (
                        f"===== attempt {attempt_no} | key {key_idx + 1}/{total_key_count} "
                        f"({key_masked}) | {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n"
                        f"ERROR: {e}\n\n"
                    ),
                )
                if _is_high_demand_error(e):
                    raise RuntimeError(
                        f"Gemini server high demand/unavailable on key {key_idx + 1}/{total_key_count}; "
                        f"stop without key rotation. Error: {e}"
                    ) from e
                if offset < key_count - 1:
                    if not _is_token_limit_error(e):
                        raise RuntimeError(
                            f"Gemini translation failed with non-rotatable error on key "
                            f"{key_idx + 1}/{total_key_count}: {e}"
                        ) from e
                    next_key_idx = (key_idx + 1) % total_key_count
                    log(
                        f"Step2: Gemini key {key_idx + 1}/{total_key_count} → "
                        f"{next_key_idx + 1}/{total_key_count}."
                    )

        if step2_multi_keys_enabled:
            raise RuntimeError(
                f"Gemini translation failed on all {total_key_count} keys. Last error: {last_error}"
            ) from last_error
        raise RuntimeError(
            f"Gemini translation failed on active key only (multi-keys off). Last error: {last_error}"
        ) from last_error

    return retry_call(
        _call, "Gemini translation", max_retry=gemini_retry_max
    )


def step2_translate_srt(srt_path):
    log = _cfg["log"]
    parse_srt = _cfg["parse_srt"]
    write_srt = _cfg["write_srt"]
    progressbar = _cfg["progressbar"]
    get_vi_srt_path = _cfg["get_vi_srt_path"]
    translate_batch_size = _cfg["translate_batch_size"]
    step2_multi_keys_enabled = _cfg["step2_multi_keys_enabled"]
    step2_vi_skip_texts_enabled = bool(_cfg.get("step2_vi_skip_texts_enabled", False))

    gemini_key_tier = _cfg.get("gemini_key_tier", "standard")
    key_mode = "multi-keys on" if step2_multi_keys_enabled else "multi-keys off"
    skip_mode = "vi-skip-texts on" if step2_vi_skip_texts_enabled else "vi-skip-texts off"
    log(f"Step2: Gemini (tier={gemini_key_tier}, {key_mode}, {skip_mode})…")
    with open(srt_path, encoding="utf8") as f:
        blocks = parse_srt(f.read())

    translated_blocks = []
    skipped_count = 0
    stripped_count = 0
    for i in progressbar(range(0, len(blocks), translate_batch_size), desc="Translate"):
        batch = blocks[i : i + translate_batch_size]
        mapping = translate_batch_with_gemini(batch, i)
        for local_idx, b in enumerate(batch):
            translated_text = mapping[local_idx]
            if step2_vi_skip_texts_enabled:
                cleaned = _strip_vi_noise_keywords(translated_text)
                if not _has_substantive_vi_text(cleaned):
                    skipped_count += 1
                    residue = cleaned or _normalize_skip_text(translated_text)
                    log(
                        f"Step2: bỏ block #{b['index']} khỏi vi.srt "
                        f"(lọc): {_normalize_skip_text(translated_text)!r}"
                        + (f" → residue {residue!r}" if residue else "")
                    )
                    continue
                if cleaned != _normalize_skip_text(translated_text):
                    stripped_count += 1
                    log(
                        f"Step2: block #{b['index']} gỡ keyword → "
                        f"{_normalize_skip_text(translated_text)!r} → {cleaned!r}"
                    )
            else:
                cleaned = _normalize_skip_text(translated_text)
                if not cleaned:
                    skipped_count += 1
                    log(
                        f"Step2: bỏ block #{b['index']} khỏi vi.srt (rỗng): "
                        f"{_normalize_skip_text(translated_text)!r}"
                    )
                    continue
            translated_blocks.append(
                {"index": b["index"], "time": b["time"], "text": cleaned}
            )

    if step2_vi_skip_texts_enabled and skipped_count:
        log(f"Step2: đã lọc {skipped_count} block khỏi vi.srt (giữ nguyên id các block còn lại).")
    elif not step2_vi_skip_texts_enabled and skipped_count:
        log(f"Step2: đã bỏ {skipped_count} block rỗng khỏi vi.srt.")
    if step2_vi_skip_texts_enabled and stripped_count:
        log(f"Step2: đã gỡ keyword trong {stripped_count} block (giữ block, xóa cụm noise).")

    out_path = get_vi_srt_path()
    write_srt(translated_blocks, out_path)
    return out_path
