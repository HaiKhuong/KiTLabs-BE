import { Type } from "class-transformer";
import { IsIn, IsNumber, IsOptional, IsString } from "class-validator";

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
  mode?: string;

  /** Step1 subtitle source: whisper | embedded */
  @IsOptional()
  @IsIn(["whisper", "embedded", "easyocr"])
  step1SubtitleSource?: string;

  @IsOptional()
  @IsIn(["whisper", "embedded", "easyocr"])
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
}
