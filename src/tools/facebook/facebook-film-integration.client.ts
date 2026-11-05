import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import axios, { AxiosError } from "axios";
import { FacebookPage } from "./facebook-page.entity";
import { FacebookPost } from "./facebook-post.entity";
import { FacebookContentKind } from "./facebook.types";

export type FilmSyncResult = {
  episodeId: string;
  sourceId: string;
  videoUrl: string;
  createdEpisode: boolean;
  createdSource: boolean;
};

type ApiEnvelope<T> = { success?: boolean; data?: T };

function unwrapApiResponse<T>(payload: T | ApiEnvelope<T>): T {
  return payload && typeof payload === "object" && "data" in payload && payload.data !== undefined
    ? payload.data
    : payload as T;
}

export function facebookPermalink(kind: FacebookContentKind, pageGraphId: string, objectId: string): string {
  return kind === FacebookContentKind.REEL
    ? `https://www.facebook.com/reel/${encodeURIComponent(objectId)}/`
    : `https://www.facebook.com/${encodeURIComponent(pageGraphId)}/videos/${encodeURIComponent(objectId)}/`;
}

export function facebookEmbedUrl(kind: FacebookContentKind, pageGraphId: string, objectId: string): string {
  const permalink = facebookPermalink(kind, pageGraphId, objectId);
  return `https://www.facebook.com/plugins/video.php?height=314&href=${encodeURIComponent(permalink)}&show_text=false&width=560&t=0`;
}

@Injectable()
export class FacebookFilmIntegrationClient {
  private config(): { baseUrl: string; key: string } {
    const baseUrl = process.env.INTEGRATION_BASE_URL?.trim().replace(/\/$/, "");
    const key = process.env.INTEGRATION_SERVICE_KEY?.trim();
    if (!baseUrl || !key) throw new ServiceUnavailableException("Chưa cấu hình kết nối Film integration");
    return { baseUrl, key };
  }

  async searchMovies(q: string) {
    const { baseUrl, key } = this.config();
    const response = await axios.get(this.endpoint(baseUrl, "/film/integrations/facebook/movies"), {
      params: { q },
      headers: { "x-film-integration-key": key },
      timeout: 10_000,
    });
    return unwrapApiResponse(response.data);
  }

  async sync(post: FacebookPost, page: FacebookPage): Promise<FilmSyncResult> {
    if (!post.facebookPostId || !post.filmMovieId || !post.filmEpisodeNumber) {
      throw new Error("Bài đăng thiếu thông tin Facebook hoặc Film");
    }
    const { baseUrl, key } = this.config();
    try {
      const permalink = facebookEmbedUrl(post.kind, page.pageId, post.facebookPostId);
      const response = await axios.post<FilmSyncResult>(
        this.endpoint(baseUrl, "/film/integrations/facebook/sync"),
        {
          facebookPostUuid: post.id,
          facebookObjectId: post.facebookPostId,
          pageGraphId: page.pageId,
          kind: post.kind,
          movieId: post.filmMovieId,
          episodeNumber: Number(post.filmEpisodeNumber),
          title: `Tập ${Number(post.filmEpisodeNumber)}`,
          permalink,
        },
        { headers: { "x-film-integration-key": key }, timeout: 15_000 },
      );
      return unwrapApiResponse(response.data as FilmSyncResult | ApiEnvelope<FilmSyncResult>);
    } catch (error) {
      const axiosError = error as AxiosError<{ message?: string | string[] }>;
      const remoteMessage = axiosError.response?.data?.message;
      const message = Array.isArray(remoteMessage) ? remoteMessage.join(", ") : remoteMessage;
      throw new Error(message || axiosError.message || "Không thể đồng bộ Film DB");
    }
  }

  private endpoint(baseUrl: string, path: string): string {
    return `${baseUrl}${baseUrl.endsWith("/api") ? "" : "/api"}${path}`;
  }
}
