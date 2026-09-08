"""Gemini client for narrato — KiTLabs keys (GEMINI_API_KEY / VIP), no Narrato config.toml."""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

LOG = logging.getLogger("narrato.gemini")

_RETRY_MAX = 1
_RETRY_DEBOUNCE_SEC = 3.0
_TRANSIENT_MARKERS = (
    "503",
    "429",
    "UNAVAILABLE",
    "RESOURCE_EXHAUSTED",
    "high demand",
    "try again",
    "timeout",
    "temporar",
    "overloaded",
)


def load_keys(tier: str = "vip") -> list[str]:
    tier = (tier or "vip").strip().lower()
    if tier in ("normal", "standard"):
        raw = os.environ.get("GEMINI_API_KEY") or ""
    else:
        raw = os.environ.get("GEMINI_API_KEY_VIP") or os.environ.get("GEMINI_API_KEY") or ""
    return [k.strip() for k in raw.split(",") if k.strip()]


def model_name(override: str = "") -> str:
    return (
        override
        or os.environ.get("NARRATO_GEMINI_MODEL")
        or os.environ.get("RECAP_GEMINI_MODEL")
        or "gemini-2.5-flash"
    ).strip()


def _is_transient(err: BaseException) -> bool:
    msg = str(err).lower()
    return any(m.lower() in msg for m in _TRANSIENT_MARKERS)


def _dump_debug(debug_dir: Path | None, name: str, data: Any) -> None:
    if not debug_dir:
        return
    try:
        debug_dir.mkdir(parents=True, exist_ok=True)
        path = debug_dir / name
        if isinstance(data, (dict, list)):
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            path.write_text(str(data or ""), encoding="utf-8")
    except Exception as exc:
        LOG.warning("Failed to write debug %s: %s", name, exc)


def generate_raw(
    system: str,
    user_obj: Any,
    *,
    model: str = "",
    key_tier: str = "",
    debug_dir: Path | None = None,
    debug_tag: str = "gemini",
    json_mode: bool = True,
    temperature: float = 0.4,
) -> str:
    tier = key_tier or os.environ.get("NARRATO_GEMINI_KEY_TIER") or os.environ.get("RECAP_GEMINI_KEY_TIER") or "vip"
    keys = load_keys(tier)
    if not keys:
        raise RuntimeError(f"No Gemini keys (tier={tier}). Set GEMINI_API_KEY or GEMINI_API_KEY_VIP.")

    model_id = model_name(model)
    LOG.info("Gemini %s model=%s", debug_tag, model_id)
    if isinstance(user_obj, str):
        prompt = system + "\n\n# INPUT\n" + user_obj
    else:
        prompt = system + "\n\n# INPUT JSON\n" + json.dumps(user_obj, ensure_ascii=False)
    _dump_debug(debug_dir, f"{debug_tag}_request.json", user_obj if not isinstance(user_obj, str) else {"text": user_obj})
    _dump_debug(debug_dir, f"{debug_tag}_prompt.txt", prompt)
    last_err: Exception | None = None

    use_new_sdk = False
    try:
        from google import genai  # type: ignore

        use_new_sdk = True
    except Exception:
        try:
            from google.generativeai import GenerativeModel, configure  # type: ignore
        except Exception as exc:
            raise RuntimeError(f"google generative AI SDK missing ({exc})") from exc

    gen_config: dict[str, Any] = {"temperature": temperature}
    if json_mode:
        gen_config["response_mime_type"] = "application/json"

    def _call_once(api_key: str) -> str:
        raw_text = ""
        if use_new_sdk:
            client = genai.Client(api_key=api_key)
            resp = client.models.generate_content(
                model=model_id,
                contents=prompt,
                config=gen_config,
            )
            raw_text = getattr(resp, "text", None) or ""
        else:
            configure(api_key=api_key)
            m = GenerativeModel(model_id, generation_config=gen_config)
            resp = m.generate_content(prompt)
            raw_text = resp.text or ""
        _dump_debug(debug_dir, f"{debug_tag}_response_raw.txt", raw_text)
        return raw_text

    transient_retried = False
    for key in keys:
        try:
            return _call_once(key)
        except Exception as err:
            last_err = err
            transient = _is_transient(err)
            LOG.warning("Gemini key failed%s: %s", " (transient)" if transient else "", err)
            if transient and not transient_retried and _RETRY_MAX >= 1:
                transient_retried = True
                time.sleep(_RETRY_DEBOUNCE_SEC)
                try:
                    return _call_once(key)
                except Exception as retry_err:
                    last_err = retry_err

    if last_err:
        _dump_debug(debug_dir, f"{debug_tag}_error.txt", str(last_err))
        raise RuntimeError(f"All Gemini attempts failed: {last_err}") from last_err
    return ""


def _strip_fence(text: str) -> str:
    raw = (text or "").strip()
    if not raw:
        return ""
    m = re.search(r"```(?:markdown|md|text)?\s*([\s\S]*?)```", raw, re.I)
    if m and len(m.group(1).strip()) > 80:
        return m.group(1).strip()
    return raw


def generate_text(
    system: str,
    user_obj: Any,
    model: str = "",
    key_tier: str = "",
    debug_dir: Path | None = None,
    debug_tag: str = "gemini",
    temperature: float = 0.3,
) -> str:
    return _strip_fence(
        generate_raw(
            system,
            user_obj,
            model=model,
            key_tier=key_tier,
            debug_dir=debug_dir,
            debug_tag=debug_tag,
            json_mode=False,
            temperature=temperature,
        )
    )


def parse_json_object(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except Exception:
        m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
        if not m:
            raise
        parsed = json.loads(m.group(1).strip())
    if isinstance(parsed, list):
        return {"items": parsed}
    if isinstance(parsed, dict):
        return parsed
    return {}


def generate_json(
    system: str,
    user_obj: Any,
    model: str = "",
    key_tier: str = "",
    debug_dir: Path | None = None,
    debug_tag: str = "gemini",
    temperature: float = 0.3,
) -> dict[str, Any]:
    raw_text = generate_raw(
        system,
        user_obj,
        model=model,
        key_tier=key_tier,
        debug_dir=debug_dir,
        debug_tag=debug_tag,
        json_mode=True,
        temperature=temperature,
    )
    parsed = parse_json_object(raw_text)
    _dump_debug(debug_dir, f"{debug_tag}_response.json", parsed)
    return parsed
