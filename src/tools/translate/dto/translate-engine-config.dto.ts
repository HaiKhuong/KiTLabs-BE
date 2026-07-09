import { Type } from "class-transformer";
import { IsIn, IsNumber, IsOptional, IsString, Max, Min } from "class-validator";

export class TranslateEngineConfigDto {
  @IsOptional()
  @IsString()
  localVideoPath?: string;

  @IsOptional()
  @IsString()
  local_video_path?: string;

  @IsOptional()
  @IsString()
  step?: string;

  @IsOptional()
  @IsString()
  subtitleFont?: string;

  @IsOptional()
  @IsString()
  subtitle_font?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitleFontsize?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitle_fontsize?: number;

  @IsOptional()
  @IsString()
  subtitlePrimaryColor?: string;

  @IsOptional()
  @IsString()
  subtitle_primary_colour?: string;

  @IsOptional()
  @IsString()
  subtitleOutlineColor?: string;

  @IsOptional()
  @IsString()
  subtitle_outline_colour?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitleOutline?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitle_outline?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitleShadow?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitle_shadow?: number;

  /** Force uppercase when writing SRT; CLI: on | off */
  @IsOptional()
  @IsIn(["on", "off"])
  subtitleUppercase?: string;

  @IsOptional()
  @IsIn(["on", "off"])
  subtitle_uppercase?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitleAlignment?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitle_alignment?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitleMarginV?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitle_margin_v?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitleBgBlurWidthRatio?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitle_bg_blur_width_ratio?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitleBgBlurHeight?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitle_bg_blur_height?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitleBgBlurBottomOffset?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitle_bg_blur_bottom_offset?: number;

  @IsOptional()
  @IsString()
  subtitleBgExtraBlursJson?: string;

  @IsOptional()
  @IsString()
  subtitle_bg_extra_blurs_json?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitleBgBlurLumaRadius?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitle_bg_blur_luma_radius?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitleBgBlurLumaPower?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitle_bg_blur_luma_power?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitleBgBlurChromaRadius?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitle_bg_blur_chroma_radius?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitleBgBlurChromaPower?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  subtitle_bg_blur_chroma_power?: number;

  @IsOptional()
  @IsString()
  logoFile?: string;

  @IsOptional()
  @IsString()
  logo_file?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  logoWidth?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  logo_width?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  logoMarginX?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  logo_margin_x?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  logoMarginY?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  logo_margin_y?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  logoOpacity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  logo_opacity?: number;

  @IsOptional()
  @IsString()
  logoEnabled?: string;

  @IsOptional()
  @IsString()
  logo_enabled?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  originalVolume?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  original_volume?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  narrationVolume?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  narration_volume?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  speedVideo?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  speed_video?: number;

  /** Tốc độ video gốc trước Step1 (1.0 = bỏ qua), CLI --preprocess-speed */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  preProcessSpeed?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  preprocess_speed?: number;

  @IsOptional()
  @IsString()
  edgeTtsVoice?: string;

  @IsOptional()
  @IsString()
  edge_tts_voice?: string;

  @IsOptional()
  @IsString()
  edgeTtsRate?: string;

  @IsOptional()
  @IsString()
  edge_tts_rate?: string;

  @IsOptional()
  @IsString()
  edgeTtsVolume?: string;

  @IsOptional()
  @IsString()
  edge_tts_volume?: string;

  @IsOptional()
  @IsString()
  edgeTtsPitch?: string;

  @IsOptional()
  @IsString()
  edge_tts_pitch?: string;

  /** edge | omnivoice */
  @IsOptional()
  @IsIn(["edge", "omnivoice"])
  step3TtsEngine?: string;

  @IsOptional()
  @IsIn(["edge", "omnivoice"])
  step3_tts_engine?: string;

  @IsOptional()
  @IsString()
  omnivoiceModelId?: string;

  @IsOptional()
  @IsString()
  omnivoice_model_id?: string;

  @IsOptional()
  @IsString()
  omnivoiceRefWav?: string;

  @IsOptional()
  @IsString()
  omnivoice_ref_wav?: string;

  @IsOptional()
  @IsString()
  omnivoiceRefText?: string;

  @IsOptional()
  @IsString()
  omnivoice_ref_text?: string;

  @IsOptional()
  @IsString()
  omnivoiceDeviceMap?: string;

  @IsOptional()
  @IsString()
  omnivoice_device_map?: string;

  @IsOptional()
  @IsString()
  omnivoiceDtype?: string;

  @IsOptional()
  @IsString()
  omnivoice_dtype?: string;

  @IsOptional()
  @IsString()
  omnivoiceLanguage?: string;

  @IsOptional()
  @IsString()
  omnivoice_language?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  omnivoiceNumStep?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  omnivoice_num_step?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  omnivoiceGuidanceScale?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  omnivoice_guidance_scale?: number;

  @IsOptional()
  @IsIn(["on", "off"])
  omnivoiceNormalizeText?: string;

  @IsOptional()
  @IsIn(["on", "off"])
  omnivoice_normalize_text?: string;

  @IsOptional()
  @IsString()
  autoSpeed?: string;

  @IsOptional()
  @IsString()
  auto_speed?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  step3AutoRateTriggerCharsPerSec?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  step3_auto_rate_trigger_chars_per_sec?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  step3AutoRateBonusPercent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  step3_auto_rate_bonus_percent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  step3TtsApiTimeoutSec?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  step3_tts_api_timeout_sec?: number;

  /** After TTS_RETRY_MAX failures: stop | skip */
  @IsOptional()
  @IsIn(["stop", "skip"])
  step3TtsMaxRetryAction?: string;

  @IsOptional()
  @IsIn(["stop", "skip"])
  step3_tts_max_retry_action?: string;

  @IsOptional()
  @IsString()
  translationContext?: string;

  @IsOptional()
  @IsString()
  translation_context?: string;

  /** Gemini key pool: standard = GEMINI_API_KEY; vip = GEMINI_API_KEY_VIP */
  @IsOptional()
  @IsIn(["standard", "vip"])
  geminiKeyTier?: string;

  @IsOptional()
  @IsIn(["standard", "vip"])
  gemini_key_tier?: string;

  /** Step2: lọc cụm noise (HAHA, Hừ, …) khỏi vi.srt — on | off */
  @IsOptional()
  @IsIn(["on", "off"])
  step2ViSkipTexts?: string;

  @IsOptional()
  @IsIn(["on", "off"])
  step2_vi_skip_texts?: string;

  @IsOptional()
  @IsString()
  mode?: string;

  /** Step1 subtitle source: whisper | vse | easyocr | paddleocr (embedded = ffmpeg stream, legacy) */
  @IsOptional()
  @IsIn(["whisper", "vse", "easyocr", "paddleocr", "embedded"])
  step1SubtitleSource?: string;

  @IsOptional()
  @IsIn(["whisper", "vse", "easyocr", "paddleocr", "embedded"])
  step1_subtitle_source?: string;

  /** EasyOCR crop band inner edge from bottom (0–1) */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  easyOcrCropBandHi?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  easy_ocr_crop_band_lo?: number;

  /** Crop ngang EasyOCR: tỷ lệ bỏ mé trái (0–0.49), CLI --easyocr-crop-probe-h-trim-left-frac */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.49)
  easyOcrCropProbeHTrimLeftFrac?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.49)
  easy_ocr_crop_probe_h_trim_left_frac?: number;

  /** Crop ngang EasyOCR: tỷ lệ bỏ mé phải (0–0.49), CLI --easyocr-crop-probe-h-trim-right-frac */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.49)
  easyOcrCropProbeHTrimRightFrac?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(0.49)
  easy_ocr_crop_probe_h_trim_right_frac?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  easyOcrMinDurationMs?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  easy_ocr_min_duration_ms?: number;

  /** Sau Step7: xóa step1_ocr + easyocr_crop_probe; CLI: on | off */
  @IsOptional()
  @IsString()
  easyOcrCleanupDebugAfterStep7?: string;

  @IsOptional()
  @IsString()
  easy_ocr_cleanup_debug_after_step7?: string;

  /** Alias snake (không gạch easy_ocr): cùng ý nghĩa với easyOcrCleanupDebugAfterStep7 */
  @IsOptional()
  @IsString()
  easyocr_cleanup_debug_after_step7?: string;

  /** Cap độ cao dải OCR (hi−lo), 0–1 (vd 0.05 = 5% chiều cao khung); 0 = tắt */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  easyOcrMaxStripHeightRatio?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  easy_ocr_max_strip_height_ratio?: number;

  /** Bật regex skip mặc định (watermark/UI); CLI on | off */
  @IsOptional()
  @IsString()
  easyOcrTextSkipDefaults?: string;

  @IsOptional()
  @IsString()
  easy_ocr_text_skip_defaults?: string;

  /** JSON array string: regex full-match block OCR sau clean */
  @IsOptional()
  @IsString()
  easyOcrTextSkipRegexesJson?: string;

  @IsOptional()
  @IsString()
  easy_ocr_text_skip_regexes_json?: string;

  @IsOptional()
  @IsString()
  easyocr_text_skip_regexes_json?: string;

  /** Confidence floor cho rescue (default 0.003): frame có conf >= floor nhưng < minConfidence sẽ được xem xét rescue bởi cluster voting. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  easyOcrLowConfFloor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  easy_ocr_low_conf_floor?: number;

  /** Số frame lân cận để vote rescue (default 8). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  easyOcrBridgeFrames?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  easy_ocr_bridge_frames?: number;

  /** Số frame tương đồng tối thiểu để rescue 1 frame low-conf (default 3). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  easyOcrBridgeMinMatch?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  easy_ocr_bridge_min_match?: number;

  /** Grayscale binary threshold (0=off, 1..254): pixel >= thresh → trắng (255), còn lại → đen. Chữ trắng / nền đen. Gợi ý: 180. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(254)
  easyOcrWhiteThresh?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(254)
  easy_ocr_white_thresh?: number;

  /** Suppress Y (luma) 0..1 trước OCR: giữ màu R/G/B, đè Y xuống thấp trong YUV. 1.0 = Y=0 (chroma-only). Bỏ qua nếu easyOcrWhiteThresh > 0. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  easyOcrLumaSuppress?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  easy_ocr_luma_suppress?: number;

  /** OCR crop: ffmpeg grayscale eq contrast */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  easyOcrGrayContrast?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  easy_ocr_gray_contrast?: number;

  /** OCR crop: grayscale brightness (~-1..1); âm làm tối, giảm watermark sáng */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  easyOcrGrayBrightness?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  easy_ocr_gray_brightness?: number;

  /** OCR crop: grayscale gamma; >1 tối midtone nhẹ */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  easyOcrGrayGamma?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  easy_ocr_gray_gamma?: number;

  /** Sau eq: ffmpeg histeq strength 0..1 (0 tắt); phẳng nền, tách chữ */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  easyOcrHisteqStrength?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  easy_ocr_histeq_strength?: number;

  /** negate luma sau histeq/unsharp; on | off */
  @IsOptional()
  @IsIn(["on", "off"])
  @IsString()
  easyOcrGrayInvert?: string;

  @IsOptional()
  @IsIn(["on", "off"])
  @IsString()
  easy_ocr_gray_invert?: string;

  /** ffmpeg unsharp=… (chỉ số và dấu : . -), vd 5:5:0.85:5:5:0.0; rỗng = tắt */
  @IsOptional()
  @IsString()
  easyOcrUnsharp?: string;

  @IsOptional()
  @IsString()
  easy_ocr_unsharp?: string;

  /** Step6 horizontal flip (ffmpeg hflip); CLI: on | off */
  @IsOptional()
  @IsString()
  step6Hflip?: string;

  @IsOptional()
  @IsString()
  step6_hflip?: string;

  @IsOptional()
  @IsString()
  enableFlip?: string;

  @IsOptional()
  @IsString()
  enable_flip?: string;

  /** Step6: zoom %% (scale+crop giữa); 0 tắt zoom */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  step6ZoomPercent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  step6_zoom_percent?: number;

  /** Step6: ffmpeg eq saturation */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  step6EqSaturation?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  step6_eq_saturation?: number;

  /** Step6: ffmpeg eq contrast */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  step6EqContrast?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  step6_eq_contrast?: number;

  /** Step7: 1080p | 2k | 4k (downscale theo nguồn) */
  @IsOptional()
  @IsString()
  exportResolution?: string;

  /** h264 | hevc — encode ưu tiên GPU (nvenc) */
  @IsOptional()
  @IsString()
  videoCodec?: string;

  @IsOptional()
  @IsString()
  video_codec?: string;

  @IsOptional()
  @IsString()
  export_resolution?: string;

  /** Step7: ghép clip outro sau video đã render; CLI on | off */
  @IsOptional()
  @IsString()
  mergeOutro?: string;

  @IsOptional()
  @IsString()
  merge_outro?: string;

  /** Đường dẫn file outro (upload), CLI --outro-file */
  @IsOptional()
  @IsString()
  outroFile?: string;

  @IsOptional()
  @IsString()
  outro_file?: string;

  /** Thư mục chứa SRT có sẵn ({video_stem}.srt); nếu có thì Step1 bỏ qua Whisper/VSE/EasyOCR */
  @IsOptional()
  @IsString()
  existingSrtDirPath?: string;

  @IsOptional()
  @IsString()
  existing_srt_dir_path?: string;
}
