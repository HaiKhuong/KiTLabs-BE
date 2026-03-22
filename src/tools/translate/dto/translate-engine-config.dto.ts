import { Type } from "class-transformer";
import { IsNumber, IsOptional, IsString } from "class-validator";

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
  translationContext?: string;
}
