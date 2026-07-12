import { Injectable, Logger } from "@nestjs/common";
import axios, { AxiosResponse } from "axios";

const YTDLP_BASE_URL = process.env.YTDLP_SERVICE_URL ?? "http://localhost:8100";

interface YtDlpFormat {
  format_id: string;
  height: number | null;
  width: number | null;
  ext: string;
  filesize: number | null;
  vcodec: string | null;
  acodec: string | null;
  fps: number | null;
  tbr: number | null;
}

interface YtDlpExtractResponse {
  id: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  uploader: string | null;
  uploader_id: string | null;
  webpage_url: string | null;
  formats: YtDlpFormat[];
}

interface YtDlpProfileVideo {
  id: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  best_height: number;
  webpage_url: string | null;
}

interface YtDlpProfileResponse {
  uploader: string | null;
  uploader_id: string | null;
  videos: YtDlpProfileVideo[];
}

export interface VideoFormat {
  formatId: string;
  label: string;
  height: number | null;
  width: number | null;
  ext: string;
  filesize: number | null;
  vcodec: string | null;
  acodec: string | null;
  fps: number | null;
}

export interface ExtractedVideoInfo {
  id: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  uploader: string | null;
  uploaderId: string | null;
  webpageUrl: string | null;
  formats: VideoFormat[];
}

export interface ProfileVideoInfo {
  id: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  bestQuality: string;
  bestHeight: number;
  webpageUrl: string | null;
}

export interface ExtractedProfileInfo {
  uploader: string | null;
  uploaderId: string | null;
  videos: ProfileVideoInfo[];
}

@Injectable()
export class DouyinService {
  private readonly logger = new Logger(DouyinService.name);

  private heightToLabel(height: number | null): string {
    if (!height) return "Unknown";
    if (height >= 4320) return "8K";
    if (height >= 2160) return "4K";
    if (height >= 1440) return "2K";
    if (height >= 1080) return "1080P";
    if (height >= 720) return "720P";
    if (height >= 480) return "480P";
    if (height >= 360) return "360P";
    return `${height}P`;
  }

  async extractVideo(url: string, cookieContent?: string): Promise<ExtractedVideoInfo> {
    const response = await axios.post<YtDlpExtractResponse>(`${YTDLP_BASE_URL}/extract`, {
      url,
      cookie_content: cookieContent || null,
    }, { timeout: 60_000 });

    const data = response.data;

    const formats: VideoFormat[] = data.formats.map((f) => ({
      formatId: f.format_id,
      label: this.heightToLabel(f.height),
      height: f.height,
      width: f.width,
      ext: f.ext,
      filesize: f.filesize,
      vcodec: f.vcodec,
      acodec: f.acodec,
      fps: f.fps,
    }));

    const seen = new Set<string>();
    const deduped = formats.filter((f) => {
      const key = `${f.height}-${f.ext}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      id: data.id,
      title: data.title,
      thumbnail: data.thumbnail,
      duration: data.duration,
      uploader: data.uploader,
      uploaderId: data.uploader_id,
      webpageUrl: data.webpage_url,
      formats: deduped,
    };
  }

  async extractProfile(url: string, cookieContent?: string, maxVideos = 20): Promise<ExtractedProfileInfo> {
    const response = await axios.post<YtDlpProfileResponse>(`${YTDLP_BASE_URL}/extract-profile`, {
      url,
      cookie_content: cookieContent || null,
      max_videos: maxVideos,
    }, { timeout: 120_000 });

    const data = response.data;

    return {
      uploader: data.uploader,
      uploaderId: data.uploader_id,
      videos: data.videos.map((v) => ({
        id: v.id,
        title: v.title,
        thumbnail: v.thumbnail,
        duration: v.duration,
        bestQuality: this.heightToLabel(v.best_height),
        bestHeight: v.best_height,
        webpageUrl: v.webpage_url,
      })),
    };
  }

  async downloadVideo(url: string, formatId?: string, cookieContent?: string): Promise<AxiosResponse> {
    const response = await axios.post(`${YTDLP_BASE_URL}/download`, {
      url,
      format_id: formatId || null,
      cookie_content: cookieContent || null,
    }, {
      timeout: 300_000,
      responseType: "stream",
    });

    return response;
  }

  async downloadThumbnail(thumbnailUrl: string): Promise<AxiosResponse> {
    const response = await axios.get(thumbnailUrl, {
      timeout: 30_000,
      responseType: "stream",
    });

    return response;
  }
}
