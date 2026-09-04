"""
Chuẩn hóa text trước TTS — dùng chung cho OmniVoice, VoxCPM2, Edge (tts_normalize_vi).

Pipeline tiếng Việt:
  acronym rules → vinorm (tuỳ chọn) → lexical rules → lowercase → dấu câu
"""

from __future__ import annotations

import re
import unicodedata

_VIETNAMESE_LANG_KEYS = frozenset({"vietnamese", "vi", "vie"})


def sanitize_tts_unicode(text: str) -> str:
    """
    Loại ký tự format/control gây lỗi tokenizer (thường do stdin Windows cp1252).
    Ví dụ: NBSP \\xa0, soft hyphen \\xad tách dấu tiếng Việt.
    """
    s = unicodedata.normalize("NFC", str(text or ""))
    s = s.replace("\ufeff", "").replace("\u00a0", " ").replace("\u00ad", "")
    cleaned: list[str] = []
    for ch in s:
        cat = unicodedata.category(ch)
        if cat in ("Cf", "Cc") and ch not in "\t\n\r":
            continue
        cleaned.append(ch)
    return re.sub(r"\s+", " ", "".join(cleaned)).strip()


def is_vietnamese_language(language: str | None) -> bool:
    key = str(language or "").strip().lower().replace("-", "_")
    return key in _VIETNAMESE_LANG_KEYS


def ensure_tts_trailing_period(text: str) -> str:
    """Đảm bảo mọi câu TTS kết thúc bằng đúng một dấu chấm."""
    t = str(text or "").strip()
    if not t:
        return t
    t = re.sub(r"[,，、;；:：!?！？…\-–—]+$", "", t).rstrip()
    if not t:
        return t
    t = re.sub(r"\.+$", ".", t)
    if not t.endswith("."):
        t = f"{t}."
    return t


def normalize_tts_text_for_audio(text: str) -> str:
    """
    Chuẩn hóa dấu câu trước TTS:
    - Bỏ dấu ngoặc kép (ASCII và typographic thường gặp).
    - Thay : ; ? ! trong câu bằng dấu chấm.
    - Gộp nhiều chấm liên tiếp; cuối đoạn gom dấu câu lặp về một dấu chấm.
    - Luôn kết thúc bằng một dấu chấm.
    """
    t = str(text or "").strip()
    if not t:
        return t
    for q in ('"', "\u201c", "\u201d", "\u2018", "\u2019", "\u00ab", "\u00bb"):
        t = t.replace(q, "")
    for p in (":", ";", "?", "!"):
        t = t.replace(p, ".")
    t = re.sub(r"\.(?:\s*\.)+", ".", t)
    t = re.sub(r"[!?.,:;…\-–—]+$", ".", t)
    return ensure_tts_trailing_period(t)


def apply_tts_acronym_rules(text: str) -> str:
    """Thay viết tắt chữ cái → cách đọc tiếng Việt. Thứ tự: dài / có khoảng trắng trước."""
    t = str(text or "")
    if not t.strip():
        return t
    t = re.sub(r"\bS\s+S\s+S\b", "Ba Ét", t, flags=re.IGNORECASE)
    t = re.sub(r"\bSSS\b", "Ba Ét", t, flags=re.IGNORECASE)
    t = re.sub(r"\bS\s+S\b", "Hai Ét", t, flags=re.IGNORECASE)
    t = re.sub(r"\bSS\b", "Hai Ét", t, flags=re.IGNORECASE)
    t = re.sub(r"\bS\b", "Ét", t, flags=re.IGNORECASE)
    t = re.sub(r"\bHACK\b", "Hách", t, flags=re.IGNORECASE)
    t = re.sub(r"\bMecha\b", "Mê cha", t, flags=re.IGNORECASE)
    t = re.sub(r"\bHaiz+\b", "Hài", t, flags=re.IGNORECASE)
    t = t.replace("A.I", "Ây Ai").replace("AI", "Ây Ai")
    t = re.sub(
        r"\bđi\s+thôi\s*[,.]\s*đi\s+thôi\b",
        "Đi thôi",
        t,
        flags=re.IGNORECASE,
    )
    return t


def apply_tts_lexical_replacements(text: str) -> str:
    """
    Thay token TTS đọc kém — luôn gọi **trước** ``.lower()``.

    Rule:
    - ``%`` → phần trăm; ``&`` → và; ``$`` → đô
    - ``AI`` (uppercase) → ây ai; ``NPC`` → Nờ Bi Xi
    - ``OK`` / ``ok`` → ô kê
    - Wi‑Fi → wai fai; ``4G`` / ``5G`` → 4 gờ / 5 gờ
    - ``AM`` / ``PM`` → sáng / chiều
    - ``24/7`` → 24 trên 7
    - ``km/h`` → ki lô mét trên giờ; ``km`` → ki lô mét
    """
    t = str(text or "")
    if not t.strip():
        return t

    t = re.sub(r"\b24\s*/\s*7\b", "24 trên 7", t)
    t = re.sub(r"\bWi\s*[-\u2011]?\s*Fi\b", "wai fai", t, flags=re.IGNORECASE)
    t = re.sub(r"\b4G\b", "4 gờ", t)
    t = re.sub(r"\b5G\b", "5 gờ", t)
    t = re.sub(r"(?<=\d)\s*AM\b", " sáng", t)
    t = re.sub(r"(?<=\d)\s*PM\b", " chiều", t)
    t = re.sub(r"\bA\.?\s*M\.?\b", "sáng", t)
    t = re.sub(r"\bP\.?\s*M\.?\b", "chiều", t)
    t = re.sub(r"\b[oO][kK]\b", "ô kê", t)
    t = re.sub(r"\bAI\b", "ây ai", t)
    t = re.sub(r"\bNPC\b", "Nờ Bi Xi", t, flags=re.IGNORECASE)
    t = re.sub(
        r"(?<=\d)\s*km\s*/\s*h\b",
        " ki lô mét trên giờ",
        t,
        flags=re.IGNORECASE,
    )
    t = re.sub(r"\bkm\s*/\s*h\b", "ki lô mét trên giờ", t, flags=re.IGNORECASE)
    t = re.sub(r"(?<=\d)\s*km\b", " ki lô mét", t, flags=re.IGNORECASE)
    t = re.sub(r"\bkm\b", "ki lô mét", t, flags=re.IGNORECASE)
    t = t.replace("%", " phần trăm ")
    t = t.replace("&", " và ")
    t = t.replace("$", " đô ")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def apply_vinorm(text: str) -> str:
    """vinorm TTSnorm + cleanup; không có vinorm → trả text gốc."""
    try:
        from vinorm import TTSnorm
    except ImportError:
        return str(text or "")
    s = str(text or "")
    t = (
        TTSnorm(s, unknown=False, lower=False, rule=True)
        .replace("..", "")
        .replace("...", "")
        .replace("!.", "")
        .replace("?.", "")
        .replace(" .", "")
        .replace(" ,", "")
        .replace('"', "")
        .replace("'", "")
        .replace("/", " phần ")
        .replace("+", " Cộng ")
    )
    return t


def prepare_tts_vi_text(text: str, *, vinorm_enabled: bool = False) -> str:
    """Pipeline normalize tiếng Việt đầy đủ."""
    t = apply_tts_acronym_rules(str(text or ""))
    if vinorm_enabled:
        t = apply_vinorm(t)
        t = apply_tts_acronym_rules(t)
    t = apply_tts_lexical_replacements(t)
    t = t.lower()
    return normalize_tts_text_for_audio(t)


def prepare_tts_input_text(
    text: str,
    language: str | None = None,
    *,
    vinorm_enabled: bool = False,
) -> str:
    """Chuẩn hóa text theo ngôn ngữ trước khi gọi model TTS."""
    text = sanitize_tts_unicode(text)
    if is_vietnamese_language(language):
        return prepare_tts_vi_text(text, vinorm_enabled=vinorm_enabled)
    return normalize_tts_text_for_audio(text)


# Alias tương thích code cũ
apply_omnivoice_lexical_replacements = apply_tts_lexical_replacements
