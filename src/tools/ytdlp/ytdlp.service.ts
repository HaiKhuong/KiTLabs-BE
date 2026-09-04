import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import axios, { AxiosResponse } from "axios";

import { AppConfigService } from "../../common/config/app-config.service";

export type YtdlpMediaFormat = "video" | "audio";

export type YtdlpVideoFormat = {
  formatId: string;
  label: string;
  height: number | null;
  width: number | null;
  ext: string;
  filesize: number | null;
};

export type YtdlpVideoInfo = {
  type: "video";
  id: string;
  title: string;
  thumbnail: string | null;
  duration: number | null;
  uploader: string | null;
  webpageUrl: string | null;
  formats: YtdlpVideoFormat[];
};

export type YtdlpPlaylistInfo = {
  type: "playlist";
  title: string | null;
  urls: string[];
};

type SidecarFormat = {
  format_id?: string;
  height?: number | null;
  width?: number | null;
  ext?: string;
  filesize?: number | null;
};

type SidecarExtractResponse = {
  type?: string;
  id?: string;
  title?: string | null;
  thumbnail?: string | null;
  duration?: number | null;
  uploader?: string | null;
  webpage_url?: string | null;
  formats?: SidecarFormat[];
  urls?: string[];
};

@Injectable()
export class YtdlpService {
  private readonly logger = new Logger(YtdlpService.name);

  constructor(private readonly appConfig: AppConfigService) {}

  private serviceUrl(): string {
    return this.appConfig.get("YTDLP_SERVICE_URL", "http://localhost:8100");
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

  private mapFormats(formats: SidecarFormat[]): YtdlpVideoFormat[] {
    const mapped = formats
      .filter((f) => f.format_id)
      .map((f) => ({
        formatId: String(f.format_id),
        label: this.heightToLabel(f.height ?? null),
        height: f.height ?? null,
        width: f.width ?? null,
        ext: f.ext || "mp4",
        filesize: f.filesize ?? null,
      }));
    mapped.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    const seen = new Set<string>();
    return mapped.filter((f) => {
      const key = f.label;
      if (key === "Unknown") return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async getInfo(url: string): Promise<YtdlpVideoInfo | YtdlpPlaylistInfo> {
    try {
      const response = await axios.post<SidecarExtractResponse>(
        `${this.serviceUrl()}/extract`,
        { url },
        { timeout: 90_000 },
      );
      const data = response.data;
      if (data.type === "playlist") {
        return {
          type: "playlist",
          title: data.title ?? null,
          urls: data.urls ?? [],
        };
      }
      return {
        type: "video",
        id: data.id ?? "",
        title: data.title ?? "Untitled",
        thumbnail: data.thumbnail ?? null,
        duration: data.duration ?? null,
        uploader: data.uploader ?? null,
        webpageUrl: data.webpage_url ?? url,
        formats: this.mapFormats(data.formats ?? []),
      };
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.detail ?? error.message
        : error instanceof Error
          ? error.message
          : "Extract failed";
      this.logger.warn(`yt-dlp info failed: ${message}`);
      throw new BadRequestException(typeof message === "string" ? message : "Extract failed");
    }
  }

  async expandPlaylist(url: string): Promise<string[]> {
    try {
      const response = await axios.post<{ urls?: string[] }>(
        `${this.serviceUrl()}/playlist`,
        { url },
        { timeout: 180_000 },
      );
      return response.data.urls ?? [];
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.detail ?? error.message
        : error instanceof Error
          ? error.message
          : "Playlist extract failed";
      this.logger.warn(`yt-dlp playlist failed: ${message}`);
      throw new BadRequestException(typeof message === "string" ? message : "Playlist extract failed");
    }
  }

  async download(
    url: string,
    format: YtdlpMediaFormat = "video",
    formatId?: string,
  ): Promise<AxiosResponse> {
    try {
      return await axios.post(
        `${this.serviceUrl()}/download`,
        {
          url,
          format_id: format === "audio" ? null : formatId || null,
          media_format: format,
        },
        { timeout: 600_000, responseType: "stream" },
      );
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.detail ?? error.message
        : error instanceof Error
          ? error.message
          : "Download failed";
      this.logger.warn(`yt-dlp download failed: ${message}`);
      throw new BadRequestException(typeof message === "string" ? message : "Download failed");
    }
  }
}
