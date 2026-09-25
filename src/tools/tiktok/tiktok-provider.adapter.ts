import { Injectable } from "@nestjs/common";
import axios, { AxiosError, AxiosInstance } from "axios";
import { createReadStream } from "fs";

import { ProviderDisclosure, TikTokVideoMetadata } from "./tiktok.types";

export class TikTokProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly logId?: string,
    readonly httpStatus?: number,
  ) {
    super("TikTok provider request failed");
  }
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  open_id: string;
  scope: string;
  expires_in: number;
  refresh_expires_in: number;
};

@Injectable()
export class TikTokProviderAdapter {
  private readonly http: AxiosInstance = axios.create({
    baseURL: process.env.TIKTOK_API_BASE_URL ?? "https://open.tiktokapis.com",
    timeout: Number(process.env.TIKTOK_HTTP_TIMEOUT_MS ?? 30_000),
  });

  authorizationUrl(state: string): string {
    const url = new URL(process.env.TIKTOK_AUTHORIZE_URL ?? "https://www.tiktok.com/v2/auth/authorize/");
    url.search = new URLSearchParams({
      client_key: this.required("TIKTOK_CLIENT_KEY"),
      response_type: "code",
      scope: process.env.TIKTOK_SCOPES ?? "user.info.basic,video.publish,video.list",
      redirect_uri: this.required("TIKTOK_REDIRECT_URI"),
      state,
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string): Promise<TokenResponse> {
    return this.tokenRequest({
      client_key: this.required("TIKTOK_CLIENT_KEY"),
      client_secret: this.required("TIKTOK_CLIENT_SECRET"),
      code,
      grant_type: "authorization_code",
      redirect_uri: this.required("TIKTOK_REDIRECT_URI"),
    });
  }

  async refreshToken(refreshToken: string): Promise<TokenResponse> {
    return this.tokenRequest({
      client_key: this.required("TIKTOK_CLIENT_KEY"),
      client_secret: this.required("TIKTOK_CLIENT_SECRET"),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  async revoke(accessToken: string): Promise<void> {
    await this.request(() =>
      this.http.post(
        "/v2/oauth/revoke/",
        new URLSearchParams({
          client_key: this.required("TIKTOK_CLIENT_KEY"),
          client_secret: this.required("TIKTOK_CLIENT_SECRET"),
          token: accessToken,
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      ),
    );
  }

  async getUser(accessToken: string): Promise<{
    openId: string;
    unionId: string | null;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
  }> {
    const response = await this.request(() =>
      this.http.get("/v2/user/info/", {
        // Keep Login Kit scope minimal. Username is refreshed from creator_info (video.publish).
        params: { fields: "open_id,union_id,display_name,avatar_url" },
        headers: this.auth(accessToken),
      }),
    );
    const user = response.data?.data?.user ?? {};
    return {
      openId: String(user.open_id ?? ""),
      unionId: user.union_id ? String(user.union_id) : null,
      username: user.username ? String(user.username) : null,
      displayName: user.display_name ? String(user.display_name) : null,
      avatarUrl: user.avatar_url ? String(user.avatar_url) : null,
    };
  }

  async creatorInfo(accessToken: string): Promise<Record<string, unknown>> {
    const response = await this.request(() =>
      this.http.post("/v2/post/publish/creator_info/query/", {}, { headers: this.jsonAuth(accessToken) }),
    );
    return response.data?.data ?? {};
  }

  async initializeDirectPost(
    accessToken: string,
    input: {
      caption: string;
      privacyLevel: string;
      disableComment: boolean;
      disableDuet: boolean;
      disableStitch: boolean;
      disclosure: ProviderDisclosure;
      isAigc: boolean;
      metadata: TikTokVideoMetadata;
    },
  ): Promise<{ publishId: string; uploadUrl: string; chunkSize: number; totalChunkCount: number }> {
    const { chunkSize, totalChunkCount } = calculateChunkPlan(input.metadata.sizeBytes);
    const response = await this.request(() =>
      this.http.post(
        "/v2/post/publish/video/init/",
        {
          post_info: {
            title: input.caption,
            privacy_level: input.privacyLevel,
            disable_comment: input.disableComment,
            disable_duet: input.disableDuet,
            disable_stitch: input.disableStitch,
            ...input.disclosure,
            is_aigc: input.isAigc,
          },
          source_info: {
            source: "FILE_UPLOAD",
            video_size: input.metadata.sizeBytes,
            chunk_size: chunkSize,
            total_chunk_count: totalChunkCount,
          },
        },
        { headers: this.jsonAuth(accessToken) },
      ),
    );
    const data = response.data?.data ?? {};
    return {
      publishId: String(data.publish_id ?? ""),
      uploadUrl: String(data.upload_url ?? ""),
      chunkSize,
      totalChunkCount,
    };
  }

  async uploadChunk(
    uploadUrl: string,
    filePath: string,
    mimeType: string,
    start: number,
    end: number,
    total: number,
  ): Promise<void> {
    await this.request(() =>
      axios.put(uploadUrl, createReadStream(filePath, { start, end }), {
        timeout: Number(process.env.TIKTOK_UPLOAD_TIMEOUT_MS ?? 120_000),
        maxBodyLength: Infinity,
        headers: {
          "Content-Type": mimeType,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${total}`,
        },
      }),
    );
  }

  async fetchPublishStatus(accessToken: string, publishId: string): Promise<Record<string, unknown>> {
    const response = await this.request(() =>
      this.http.post(
        "/v2/post/publish/status/fetch/",
        { publish_id: publishId },
        { headers: this.jsonAuth(accessToken) },
      ),
    );
    return response.data?.data ?? {};
  }

  async listVideos(accessToken: string, maxCount: number, cursor?: string): Promise<Record<string, unknown>> {
    const response = await this.request(() =>
      this.http.post(
        "/v2/video/list/",
        { max_count: Math.min(maxCount, 20), ...(cursor ? { cursor: Number(cursor) } : {}) },
        {
          params: {
            fields:
              "id,title,video_description,create_time,cover_image_url,share_url,duration,height,width,like_count,comment_count,share_count,view_count,is_aigc",
          },
          headers: this.jsonAuth(accessToken),
        },
      ),
    );
    return response.data?.data ?? {};
  }

  private async tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
    const response = await this.request(() =>
      this.http.post("/v2/oauth/token/", new URLSearchParams(body), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }),
    );
    return response.data as TokenResponse;
  }

  private async request<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      const payload = (result as { data?: { error?: { code?: string; log_id?: string } } }).data;
      const providerError = payload?.error;
      if (providerError?.code && providerError.code !== "ok") {
        throw new TikTokProviderError(
          providerError.code,
          isRetryableProviderCode(providerError.code),
          providerError.log_id,
        );
      }
      return result;
    } catch (error) {
      if (error instanceof TikTokProviderError) throw error;
      const axiosError = error as AxiosError<{ error?: { code?: string; log_id?: string } }>;
      const status = axiosError.response?.status;
      const provider = axiosError.response?.data?.error;
      throw new TikTokProviderError(
        provider?.code ??
          (status === 429 ? "RATE_LIMITED" : status && status >= 500 ? "PROVIDER_UNAVAILABLE" : "PROVIDER_REJECTED"),
        status === 429 || Boolean(status && status >= 500),
        provider?.log_id,
        status,
      );
    }
  }

  private auth(accessToken: string): Record<string, string> {
    return { Authorization: `Bearer ${accessToken}` };
  }

  private jsonAuth(accessToken: string): Record<string, string> {
    return { ...this.auth(accessToken), "Content-Type": "application/json; charset=UTF-8" };
  }

  private required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  }
}

function isRetryableProviderCode(code: string): boolean {
  return [
    "rate_limit_exceeded",
    "internal_error",
    "PROVIDER_UNAVAILABLE",
    "RATE_LIMITED",
  ].includes(code);
}

export function calculateChunkSize(totalBytes: number): number {
  return calculateChunkPlan(totalBytes).chunkSize;
}

export function calculateChunkPlan(totalBytes: number): {
  chunkSize: number;
  totalChunkCount: number;
} {
  const min = 5 * 1024 * 1024;
  const max = 64 * 1024 * 1024;
  if (totalBytes <= max) return { chunkSize: totalBytes, totalChunkCount: 1 };
  const preferred = Math.min(max, Math.max(min, Number(process.env.TIKTOK_UPLOAD_CHUNK_BYTES ?? 32 * 1024 * 1024)));
  const chunkSize = Math.min(preferred, Math.floor(totalBytes / 2));
  // TikTok defines total_chunk_count as floor(video_size / chunk_size).
  // The trailing bytes are merged into the final chunk, which may be up to 128 MB.
  const totalChunkCount = Math.floor(totalBytes / chunkSize);
  return { chunkSize, totalChunkCount };
}
