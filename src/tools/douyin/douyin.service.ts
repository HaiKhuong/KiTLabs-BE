import { Injectable, Logger } from "@nestjs/common";
import axios, { AxiosResponse } from "axios";

import {
  DOUYIN_PLAYWRIGHT_SERVICE_URL,
  DOUYIN_PROFILE_EXTRACT_PROVIDER,
  DOUYIN_VIDEO_EXTRACT_PROVIDER,
  DouyinExtractProvider,
  YTDLP_SERVICE_URL,
} from "./douyin.constants";
import { detectDouyinUrlType, DouyinUrlType } from "./douyin-url.util";
import { getDouyinCookieContent } from "./douyin-cookies";

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

interface PlaywrightVideoFormat {
  format_id: string;
  height: number | null;
  width: number | null;
  ext: string;
  filesize: number | null;
  play_url: string | null;
}

interface PlaywrightExtractResponse {
  id: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  uploader: string | null;
  uploader_id: string | null;
  webpage_url: string | null;
  formats: PlaywrightVideoFormat[];
}

interface PlaywrightProfileVideo {
  id: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  best_height: number;
  webpage_url: string | null;
  formats: PlaywrightVideoFormat[];
}

interface PlaywrightProfileResponse {
  uploader: string | null;
  uploader_id: string | null;
  videos: PlaywrightProfileVideo[];
  has_more: boolean;
  next_cursor: number;
  cursor: number;
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
  playUrl?: string | null;
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
  provider: DouyinExtractProvider;
}

export interface ProfileVideoInfo {
  id: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  bestQuality: string;
  bestHeight: number;
  webpageUrl: string | null;
  formats: VideoFormat[];
}

export interface ExtractedUrlInfo {
  type: DouyinUrlType;
  data: ExtractedVideoInfo | ExtractedProfileInfo;
}

export interface ExtractedProfileInfo {
  uploader: string | null;
  uploaderId: string | null;
  videos: ProfileVideoInfo[];
  hasMore: boolean;
  nextCursor: number;
  cursor: number;
  provider: DouyinExtractProvider;
}

@Injectable()
export class DouyinService {
  private readonly logger = new Logger(DouyinService.name);

  private resolveCookieContent(): string | null {
    const cookieContent = getDouyinCookieContent();
    if (!cookieContent) {
      this.logger.warn(
        "Douyin cookies not configured. Set DOUYIN_COOKIE_FILE or DOUYIN_COOKIE_CONTENT.",
      );
    }
    return cookieContent;
  }

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

  private mapYtDlpFormats(formats: YtDlpFormat[]): VideoFormat[] {
    const mapped = formats.map((f) => ({
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
    return mapped.filter((f) => {
      const key = `${f.height}-${f.ext}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private mapPlaywrightFormats(formats: PlaywrightVideoFormat[]): VideoFormat[] {
    return formats.map((f) => ({
      formatId: f.format_id,
      label: this.heightToLabel(f.height),
      height: f.height,
      width: f.width,
      ext: f.ext,
      filesize: f.filesize,
      vcodec: null,
      acodec: null,
      fps: null,
      playUrl: f.play_url,
    }));
  }

  private async extractVideoViaYtDlp(url: string): Promise<ExtractedVideoInfo> {
    const cookieContent = this.resolveCookieContent();
    const response = await axios.post<YtDlpExtractResponse>(`${YTDLP_SERVICE_URL}/extract`, {
      url,
      cookie_content: cookieContent,
    }, { timeout: 60_000 });

    const data = response.data;

    return {
      id: data.id,
      title: data.title,
      thumbnail: data.thumbnail,
      duration: data.duration,
      uploader: data.uploader,
      uploaderId: data.uploader_id,
      webpageUrl: data.webpage_url,
      formats: this.mapYtDlpFormats(data.formats || []),
      provider: "ytdlp",
    };
  }

  private async extractVideoViaPlaywright(url: string): Promise<ExtractedVideoInfo> {
    const cookieContent = this.resolveCookieContent();
    const response = await axios.post<PlaywrightExtractResponse>(
      `${DOUYIN_PLAYWRIGHT_SERVICE_URL}/extract`,
      {
        url,
        cookie_content: cookieContent,
      },
      { timeout: 120_000 },
    );

    const data = response.data;

    return {
      id: data.id,
      title: data.title,
      thumbnail: data.thumbnail,
      duration: data.duration,
      uploader: data.uploader,
      uploaderId: data.uploader_id,
      webpageUrl: data.webpage_url,
      formats: this.mapPlaywrightFormats(data.formats || []),
      provider: "playwright",
    };
  }

  private async extractProfileViaYtDlp(
    url: string,
    maxVideos = 20,
  ): Promise<ExtractedProfileInfo> {
    const cookieContent = this.resolveCookieContent();
    const response = await axios.post<YtDlpProfileResponse>(
      `${YTDLP_SERVICE_URL}/extract-profile`,
      {
        url,
        cookie_content: cookieContent,
        max_videos: maxVideos,
      },
      { timeout: 180_000 },
    );

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
        formats: [],
      })),
      hasMore: false,
      nextCursor: 0,
      cursor: 0,
      provider: "ytdlp",
    };
  }

  private async extractProfileViaPlaywright(
    url: string,
    maxVideos = 20,
    cursor = 0,
  ): Promise<ExtractedProfileInfo> {
    const cookieContent = this.resolveCookieContent();
    const response = await axios.post<PlaywrightProfileResponse>(
      `${DOUYIN_PLAYWRIGHT_SERVICE_URL}/extract-profile`,
      {
        url,
        cookie_content: cookieContent,
        max_videos: maxVideos,
        cursor,
      },
      { timeout: 180_000 },
    );

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
        formats: this.mapPlaywrightFormats(v.formats || []),
      })),
      hasMore: Boolean(data.has_more),
      nextCursor: data.next_cursor ?? 0,
      cursor: data.cursor ?? cursor,
      provider: "playwright",
    };
  }

  async extractByUrl(
    url: string,
    maxVideos = 20,
    cursor = 0,
  ): Promise<ExtractedUrlInfo> {
    const type = detectDouyinUrlType(url);
    this.logger.debug(`extractByUrl type=${type} url=${url} cursor=${cursor}`);

    if (type === "profile") {
      const data = await this.extractProfile(url, maxVideos, cursor);
      return { type: "profile", data };
    }

    if (cursor > 0) {
      this.logger.warn("cursor ignored for video URL");
    }

    const data = await this.extractVideo(url);
    return { type: "video", data };
  }

  async extractVideo(url: string): Promise<ExtractedVideoInfo> {
    const provider = DOUYIN_VIDEO_EXTRACT_PROVIDER;
    this.logger.debug(`extractVideo provider=${provider} url=${url}`);

    if (provider === "ytdlp") {
      return this.extractVideoViaYtDlp(url);
    }

    return this.extractVideoViaPlaywright(url);
  }

  async extractProfile(
    url: string,
    maxVideos = 20,
    cursor = 0,
  ): Promise<ExtractedProfileInfo> {
    const provider = DOUYIN_PROFILE_EXTRACT_PROVIDER;
    this.logger.debug(`extractProfile provider=${provider} url=${url} cursor=${cursor}`);

    if (provider === "ytdlp") {
      if (cursor > 0) {
        this.logger.warn("yt-dlp profile extract does not support pagination; cursor ignored");
      }
      return this.extractProfileViaYtDlp(url, maxVideos);
    }

    return this.extractProfileViaPlaywright(url, maxVideos, cursor);
  }

  async downloadVideo(
    url: string,
    formatId?: string,
    directUrl?: string,
  ): Promise<AxiosResponse> {
    if (directUrl) {
      return axios.get(directUrl, {
        timeout: 300_000,
        responseType: "stream",
        headers: {
          Referer: "https://www.douyin.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      });
    }

    const cookieContent = this.resolveCookieContent();
    const response = await axios.post(`${YTDLP_SERVICE_URL}/download`, {
      url,
      format_id: formatId || null,
      cookie_content: cookieContent,
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
