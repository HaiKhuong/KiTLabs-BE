"""
Step 2: Gemini translate (zh -> vi) for subtitle batches.

Gọi configure_step2_gemini(...) trước khi dùng step2_translate_srt.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, Callable, List, Optional

from google import genai

_cfg: dict[str, Any] = {}

# Gemini clients initialized after configure
_gemini_api_keys: List[str] = []
_gemini_clients: List[genai.Client] = []
_active_key_index: int = 0


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
    gemini_api_keys: List[str],
    gemini_model_name: str,
    gemini_retry_max: int,
    translate_batch_size: int,
    translation_context: str,
    step2_multi_keys_enabled: bool,
) -> None:
    global _gemini_api_keys, _gemini_clients, _active_key_index

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
        gemini_model_name=str(gemini_model_name or ""),
        gemini_retry_max=int(gemini_retry_max),
        translate_batch_size=int(translate_batch_size),
        translation_context=str(translation_context or ""),
        step2_multi_keys_enabled=bool(step2_multi_keys_enabled),
    )

    _gemini_api_keys = list(gemini_api_keys or [])
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


def _parse_response(text: str) -> dict[int, str]:
    """Try JSON first, fallback to line format."""
    # Try JSON format first
    try:
        data = _extract_json_array(text)
        mapped = {}
        for item in data:
            idx = int(item["id"])
            mapped[idx] = str(item["vi"]).strip()
        return mapped
    except (ValueError, KeyError, json.JSONDecodeError):
        pass

    # Fallback to line format
    mapped = _parse_line_format(text)
    if mapped:
        return mapped

    raise ValueError(f"Cannot parse response (not JSON or line format): {text[:200]}")


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

    # Build line-based payload: "0:|text\n1:|text\n..."
    payload_lines = [f"{i}:|{b['text']}" for i, b in enumerate(batch)]
    payload_text = "\n".join(payload_lines)

    # Build compact prompt
    prompt_parts = [
        "Translate Chinese subtitles into Vietnamese.\n"
        "Write very concise, subtitle-friendly Vietnamese.\n"
        "Keep original meaning and emotional tone, but simplify phrasing.\n"
        "Preserve historical tone, titles, names, and relationships.\n"
    ]

    # Add custom context if provided, otherwise use default
    if translation_context and translation_context.strip():
        prompt_parts.append(f"{translation_context.strip()}\n")
    else:
        prompt_parts.append(
            "Han-Viet terms OK. Historical/wuxia context.\n"
        )

    prompt_parts.append(
        f"Output same format: id:|vi\n{payload_text}"
    )

    prompt = "".join(prompt_parts)

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
                mapped = _parse_response(raw_text)
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
                    # User requirement: high demand/server overload must stop immediately.
                    raise RuntimeError(
                        f"Gemini server high demand/unavailable on key {key_idx + 1}/{total_key_count}; "
                        f"stop without key rotation. Error: {e}"
                    ) from e
                if offset < key_count - 1:
                    if not _is_token_limit_error(e):
                        # Only rotate keys for token/quota/rate-limit class errors.
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

    key_mode = "multi-keys on" if step2_multi_keys_enabled else "multi-keys off"
    log(f"Step2: Gemini ({key_mode})…")
    with open(srt_path, encoding="utf8") as f:
        blocks = parse_srt(f.read())

    translated_blocks = []
    for i in progressbar(range(0, len(blocks), translate_batch_size), desc="Translate"):
        batch = blocks[i : i + translate_batch_size]
        mapping = translate_batch_with_gemini(batch, i)
        for local_idx, b in enumerate(batch):
            translated_text = mapping.get(local_idx, b["text"])
            translated_blocks.append(
                {"index": b["index"], "time": b["time"], "text": translated_text}
            )

    out_path = get_vi_srt_path()
    write_srt(translated_blocks, out_path)
    return out_path
