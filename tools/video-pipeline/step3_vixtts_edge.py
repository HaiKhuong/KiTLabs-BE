"""
ViXTTS (Coqui XTTS) và Edge TTS cho Step3 — tách khỏi auto_vietsub_pro.

Gọi configure_step3_vixtts_edge(...) trước khi dùng các hàm synthesize / edge save
(trong cùng một lần chạy step3_generate_voice_from_srt).
"""

from __future__ import annotations

import asyncio
import inspect
import re
from pathlib import Path
from types import MethodType
from typing import Any, Callable, Optional

_cfg: dict[str, Any] = {}

_vixtts_model_singleton: Any = None
_vixtts_model_dir_loaded: Optional[str] = None


def configure_step3_vixtts_edge(
    *,
    log: Callable[[str], None],
    run_command: Callable,
    ffmpeg_bin: str,
    vixtts_normalize_text: bool,
    vixtts_inference_speed: float,
    vixtts_output_volume_gain: float,
    vixtts_pitch_shift_semitones: float,
    edge_tts_voice: str,
    edge_tts_volume: str,
    edge_tts_pitch: str,
    step3_tts_api_timeout_sec: float,
) -> None:
    """Cập nhật cấu hình runtime (gọi mỗi lần vào Step3 với giá trị CLI/globals hiện tại)."""
    _cfg.clear()
    _cfg.update(
        log=log,
        run_command=run_command,
        ffmpeg_bin=ffmpeg_bin,
        vixtts_normalize_text=bool(vixtts_normalize_text),
        vixtts_inference_speed=float(vixtts_inference_speed),
        vixtts_output_volume_gain=float(vixtts_output_volume_gain),
        vixtts_pitch_shift_semitones=float(vixtts_pitch_shift_semitones),
        edge_tts_voice=str(edge_tts_voice or ""),
        edge_tts_volume=str(edge_tts_volume or ""),
        edge_tts_pitch=str(edge_tts_pitch or ""),
        step3_tts_api_timeout_sec=float(step3_tts_api_timeout_sec),
    )


def _log(msg: str) -> None:
    _cfg["log"](msg)


def tts_normalize_vi(text, enabled: bool):
    if not enabled:
        return text
    try:
        from vinorm import TTSnorm
    except ImportError:
        return text
    t = (
        TTSnorm(str(text or ""), unknown=False, lower=False, rule=True)
        .replace("..", "")
        .replace("...", "")
        .replace("!.", "")
        .replace("?.", "")
        .replace(" .", "")
        .replace(" ,", "")
        .replace('"', "")
        .replace("'", "")
        .replace("AI", "Ây Ai")
        .replace("A.I", "Ây Ai")
    )
    return t


def _vixtts_normalize_text_vi(text):
    return tts_normalize_vi(text, _cfg["vixtts_normalize_text"])


def _vixtts_parse_torch_major_minor(version_str):
    if not version_str:
        return None
    base = str(version_str).split("+", 1)[0].strip()
    parts = base.split(".")
    try:
        major = int(parts[0])
        minor = int(parts[1]) if len(parts) > 1 else 0
        return major, minor
    except (ValueError, IndexError):
        return None


def warn_if_vixtts_torchcodec_prone() -> None:
    try:
        import torch

        mm = _vixtts_parse_torch_major_minor(getattr(torch, "__version__", "") or "")
        if mm is None:
            return
        major, minor = mm
        if major > 2 or (major == 2 and minor >= 9):
            _log(
                "ViXTTS: PyTorch %s — nếu gặp lỗi libtorchcodec, pin torch/torchaudio<2.9 "
                "theo tools/video-pipeline/requirements.txt, hoặc cài FFmpeg full-shared (Windows) "
                "và TorchCodec đúng bảng tương thích PyTorch."
                % (torch.__version__,)
            )
    except Exception:
        pass


def _vixtts_reraise_torchcodec_clarified(exc):
    err_l = str(exc).lower()
    if "torchcodec" in err_l or "libtorchcodec" in err_l:
        raise RuntimeError(
            "ViXTTS / Step3: không tải được libtorchcodec (TorchCodec). "
            "PyTorch 2.9+ thường kích hoạt torchaudio/TorchCodec và cần FFmpeg shared + DLL đúng (Windows: bản full-shared). "
            "Cách ổn định cho repo này: cài đúng tools/video-pipeline/requirements.txt — "
            'pip install -U "torch>=2.2,<2.9" "torchaudio>=2.2,<2.9" '
            "(chọn --index-url wheel CUDA phù hợp nếu dùng GPU). "
            "Hoặc làm theo bảng phiên bản TorchCodec: "
            "https://github.com/pytorch/torchcodec#installing-torchcodec\n"
            f"--- Lỗi gốc ---\n{exc}"
        ) from exc
    raise exc


def _vixtts_calculate_keep_len(text, lang):
    if lang in ("ja", "zh-cn", "zh"):
        return -1
    word_count = len(str(text or "").split())
    num_punct = str(text or "").count(".") + str(text or "").count("!")
    num_punct += str(text or "").count("?") + str(text or "").count(",")
    if word_count < 5:
        return 15000 * word_count + 2000 * num_punct
    if word_count < 10:
        return 13000 * word_count + 2000 * num_punct
    return -1


def _vixtts_sentence_split(text, lang):
    t = str(text or "").strip()
    if not t:
        return []
    if lang in ("ja", "zh-cn", "zh"):
        return [s for s in t.split("。") if s.strip()]
    try:
        from underthesea import sent_tokenize

        return [s for s in sent_tokenize(t) if str(s).strip()]
    except Exception:
        return [t]


def prepare_speaker_reference(speaker_in: Path, cache_dir: Path) -> Path:
    """WAV giữ nguyên; mp3/m4a/… → WAV 24kHz mono (dùng chung ViXTTS / OmniVoice)."""
    p = Path(speaker_in).expanduser().resolve()
    if not p.is_file():
        raise FileNotFoundError(f"Step3 TTS: không tìm thấy file giọng mẫu: {p}")
    suf = p.suffix.lower()
    if suf == ".wav":
        return p
    cache_dir.mkdir(parents=True, exist_ok=True)
    out_wav = cache_dir / "vixtts_speaker_ref_converted.wav"
    _cfg["run_command"](
        [
            _cfg["ffmpeg_bin"],
            "-y",
            "-i",
            str(p),
            "-ac",
            "1",
            "-ar",
            "24000",
            "-c:a",
            "pcm_s16le",
            str(out_wav),
        ],
        f"Step3 TTS: chuyển giọng mẫu {p.suffix} → WAV 24kHz mono",
    )
    return out_wav.resolve()


def _vixtts_ensure_speakers_xtts(model_dir: Path):
    target = model_dir / "speakers_xtts.pth"
    if target.is_file():
        return target
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as e:
        raise RuntimeError(
            "ViXTTS: thiếu speakers_xtts.pth trong model dir và không cài huggingface_hub "
            "(pip install huggingface_hub)."
        ) from e
    _log("ViXTTS: tải speakers_xtts.pth từ coqui/XTTS-v2…")
    hf_hub_download(
        repo_id="coqui/XTTS-v2",
        filename="speakers_xtts.pth",
        local_dir=str(model_dir),
    )
    if not target.is_file():
        raise FileNotFoundError(f"ViXTTS: không tạo được {target}")
    return target


def _vixtts_patch_tokenizer_char_limits(model):
    tok = getattr(model, "tokenizer", None)
    limits = getattr(tok, "char_limits", None)
    if not isinstance(limits, dict):
        return
    cfg = getattr(model, "config", None)
    langs = list(getattr(cfg, "languages", None) or [])
    fallback = int(limits.get("en", 250))
    for lg in langs:
        if not lg:
            continue
        lg = str(lg).strip()
        if lg in limits:
            continue
        root = lg.split("-", 1)[0]
        pick = limits.get(root)
        if pick is None and root == "zh":
            pick = limits.get("zh")
        if pick is None:
            pick = fallback
        limits[lg] = int(pick)


def _vixtts_basic_text_clean(txt):
    t = str(txt or "").lower()
    t = re.sub(r"\s+", " ", t)
    return t.strip()


def _vixtts_patch_tokenizer_preprocess(model):
    if getattr(model, "_vixtts_preprocess_patched", False):
        return
    tok = getattr(model, "tokenizer", None)
    if tok is None:
        return
    cfg = getattr(model, "config", None)
    extra = {
        str(x).strip().split("-", 1)[0]
        for x in (getattr(cfg, "languages", None) or [])
        if x and str(x).strip()
    }
    stock_full = {
        "ar",
        "cs",
        "de",
        "en",
        "es",
        "fr",
        "hu",
        "it",
        "ja",
        "hi",
        "nl",
        "pl",
        "pt",
        "ru",
        "tr",
        "zh",
        "ko",
    }
    orig = type(tok).preprocess_text

    def preprocess_text(self, txt, lang):
        lang0 = str(lang).split("-", 1)[0]
        if lang0 in extra and lang0 not in stock_full:
            return _vixtts_basic_text_clean(txt)
        return orig(self, txt, lang)

    tok.preprocess_text = MethodType(preprocess_text, tok)
    model._vixtts_preprocess_patched = True


def _vixtts_inference_accepts_speed(model):
    try:
        sig = inspect.signature(model.inference)
        return "speed" in sig.parameters
    except (TypeError, ValueError, AttributeError):
        return False


def _vixtts_apply_speed_timeline_numpy(wav, speed):
    import numpy as np
    import torch
    import torch.nn.functional as F

    if wav is None or speed <= 0 or abs(float(speed) - 1.0) < 1e-6:
        return wav
    arr = np.asarray(wav, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        return wav
    new_len = max(1, int(round(arr.size / float(speed))))
    t = torch.from_numpy(arr).view(1, 1, -1)
    out = F.interpolate(t, size=new_len, mode="linear", align_corners=False)
    return out.squeeze().numpy()


def _vixtts_apply_pitch_shift_wav_ffmpeg(in_wav: Path, semitones: float) -> None:
    st = float(semitones)
    if abs(st) < 1e-6:
        return
    factor = 2.0 ** (st / 12.0)
    if factor <= 0.5 or factor >= 2.0:
        raise ValueError(
            "ViXTTS pitch shift ngoài khoảng hỗ trợ (-12..+12 semitones cho filter atempo)."
        )
    tmp = in_wav.with_name(f"{in_wav.stem}.pitch_tmp.wav")
    af = (
        f"asetrate=24000*{factor:.8f},"
        f"aresample=24000,"
        f"atempo={1.0 / factor:.8f}"
    )
    _cfg["run_command"](
        [
            _cfg["ffmpeg_bin"],
            "-y",
            "-i",
            str(in_wav),
            "-af",
            af,
            "-c:a",
            "pcm_s16le",
            str(tmp),
        ],
        "ViXTTS: pitch-shift output wav",
    )
    tmp.replace(in_wav)


def vixtts_load_model(model_dir: Path, use_deepspeed: bool):
    global _vixtts_model_singleton, _vixtts_model_dir_loaded
    import torch

    d = str(model_dir.resolve())
    if _vixtts_model_singleton is not None and _vixtts_model_dir_loaded == d:
        return _vixtts_model_singleton
    try:
        from TTS.tts.configs.xtts_config import XttsConfig
        from TTS.tts.models.xtts import Xtts
    except ImportError as e:
        raise RuntimeError(
            "ViXTTS cần gói Coqui TTS (pip install coqui-tts). "
            "Một số checkpoint có thể cần fork TTS tương thích — xem model card."
        ) from e
    except Exception as e:
        _vixtts_reraise_torchcodec_clarified(e)
    for name in ("model.pth", "config.json", "vocab.json"):
        p = model_dir / name
        if not p.is_file():
            raise FileNotFoundError(f"ViXTTS: thiếu file trong model dir: {p}")
    _vixtts_ensure_speakers_xtts(model_dir)
    cfg_path = model_dir / "config.json"
    config = XttsConfig()
    config.load_json(str(cfg_path))
    model = Xtts.init_from_config(config)
    model.load_checkpoint(
        config, checkpoint_dir=str(model_dir), use_deepspeed=bool(use_deepspeed)
    )
    _vixtts_patch_tokenizer_char_limits(model)
    _vixtts_patch_tokenizer_preprocess(model)

    ok_sp = _vixtts_inference_accepts_speed(model)
    model._vixtts_inference_accepts_speed_param = ok_sp
    sp0 = float(_cfg["vixtts_inference_speed"])
    if abs(sp0 - 1.0) > 1e-6:
        if ok_sp:
            _log(f"ViXTTS: model.inference có tham số speed — đang dùng speed={sp0}.")
        else:
            _log(
                f"ViXTTS: model.inference không có speed — áp dụng ×{sp0} bằng nội suy sóng sau sinh."
            )

    if torch.cuda.is_available():
        model.cuda()
        _log("ViXTTS: dùng CUDA.")
    else:
        _log("ViXTTS: CUDA không có — chạy CPU (chậm).")
    _vixtts_model_singleton = model
    _vixtts_model_dir_loaded = d
    return model


def vixtts_synthesize_to_file(
    model,
    text,
    lang,
    out_wav: Path,
    gpt_cond_latent,
    speaker_embedding,
):
    import torch

    try:
        import torchaudio
    except Exception as e:
        _vixtts_reraise_torchcodec_clarified(e)

    tts_text = str(text or "").strip()
    if lang == "vi" and _cfg["vixtts_normalize_text"]:
        tts_text = _vixtts_normalize_text_vi(tts_text)
    tts_text = str(tts_text or "").lower()
    sentences = _vixtts_sentence_split(tts_text, lang)
    if not sentences:
        raise ValueError("ViXTTS: text rỗng sau tách câu.")
    wav_chunks = []
    for sentence in sentences:
        st = str(sentence).strip()
        if not st:
            continue

        infer_kwargs = dict(
            text=st,
            language=lang,
            gpt_cond_latent=gpt_cond_latent,
            speaker_embedding=speaker_embedding,
            temperature=0.6,
            length_penalty=1.0,
            repetition_penalty=2.2,
            top_k=50,
            top_p=0.9,
            enable_text_splitting=False,
        )
        accepts = getattr(model, "_vixtts_inference_accepts_speed_param", None)
        if accepts is None:
            accepts = _vixtts_inference_accepts_speed(model)
            model._vixtts_inference_accepts_speed_param = accepts

        sp = float(_cfg["vixtts_inference_speed"])
        used_api_speed = False
        if accepts and abs(sp - 1.0) > 1e-6:
            try:
                wav_chunk = model.inference(**infer_kwargs, speed=sp)
                used_api_speed = True
            except TypeError as e:
                _log(f"ViXTTS: inference(speed={sp}) lỗi ({e}); nội suy sóng.")
                wav_chunk = model.inference(**infer_kwargs)
        else:
            wav_chunk = model.inference(**infer_kwargs)

        wav = wav_chunk["wav"]
        if not used_api_speed and abs(sp - 1.0) > 1e-6:
            wav = _vixtts_apply_speed_timeline_numpy(wav, sp)
        keep_len = _vixtts_calculate_keep_len(st, lang)
        if keep_len is not None and int(keep_len) > 0:
            wav = wav[: int(keep_len)]
        wav_chunks.append(torch.tensor(wav, dtype=torch.float32))
    if not wav_chunks:
        raise ValueError("ViXTTS: không sinh được chunk âm thanh.")
    wave_tensor = torch.cat(wav_chunks, dim=0).unsqueeze(0)
    gain = float(_cfg["vixtts_output_volume_gain"])
    if gain > 0.0 and gain != 1.0:
        wave_tensor = (wave_tensor * gain).clamp(-1.0, 1.0)
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    try:
        torchaudio.save(str(out_wav), wave_tensor, 24000)
    except Exception as e:
        _vixtts_reraise_torchcodec_clarified(e)
    semitones = float(_cfg["vixtts_pitch_shift_semitones"])
    if abs(semitones) > 1e-6:
        _vixtts_apply_pitch_shift_wav_ffmpeg(out_wav, semitones)


async def edge_tts_save_mp3_async(text, out_path, rate: str) -> None:
    import edge_tts

    communicate = edge_tts.Communicate(
        text=text,
        voice=_cfg["edge_tts_voice"],
        rate=rate,
        volume=_cfg["edge_tts_volume"],
        pitch=_cfg["edge_tts_pitch"],
    )
    out = str(out_path)
    timeout_sec = float(_cfg["step3_tts_api_timeout_sec"])
    if timeout_sec <= 0:
        await communicate.save(out)
    else:
        try:
            await asyncio.wait_for(communicate.save(out), timeout=timeout_sec)
        except asyncio.TimeoutError as exc:
            raise TimeoutError(
                f"edge-tts request timed out after {timeout_sec:.1f}s"
            ) from exc


def run_edge_tts_mp3_save(text, out_path, rate: str) -> None:
    """Gọi edge-tts lưu MP3 (sync wrapper)."""
    asyncio.run(edge_tts_save_mp3_async(text, out_path, rate))
