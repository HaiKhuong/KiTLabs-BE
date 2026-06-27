import { Injectable, Logger } from "@nestjs/common";
import { google, youtube_v3, youtubeAnalytics_v2 } from "googleapis";

export interface ChannelInfo {
  id: string;
  title: string;
  thumbnail: string | null;
  subscriberCount: number;
  videoCount: number;
  viewCount: number;
}

export interface VideoInfo {
  id: string;
  title: string;
  thumbnail: string | null;
  description: string | null;
  publishedAt: string | null;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}

export interface VideoAnalytics {
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  likes: number;
  comments: number;
  shares: number;
  subscribersGained: number;
  subscribersLost: number;
  impressions: number;
  ctr: number;
  revenue: number;
}

export interface DailyAnalytics {
  date: string;
  views: number;
  estimatedMinutesWatched: number;
  averageViewDuration: number;
  subscribersGained: number;
  subscribersLost: number;
  impressions: number;
  ctr: number;
  revenue: number;
  likes: number;
  comments: number;
  shares: number;
}

@Injectable()
export class YouTubeApiService {
  private readonly logger = new Logger(YouTubeApiService.name);

  async listChannels(accessToken: string): Promise<ChannelInfo[]> {
    const youtube = google.youtube({ version: "v3", auth: this.createAuth(accessToken) });

    const response = await youtube.channels.list({
      part: ["snippet", "statistics"],
      mine: true,
    });

    return (response.data.items ?? []).map((item) => ({
      id: item.id!,
      title: item.snippet?.title ?? "",
      thumbnail: item.snippet?.thumbnails?.default?.url ?? null,
      subscriberCount: Number(item.statistics?.subscriberCount ?? 0),
      videoCount: Number(item.statistics?.videoCount ?? 0),
      viewCount: Number(item.statistics?.viewCount ?? 0),
    }));
  }

  async getChannelInfo(accessToken: string, channelId: string): Promise<ChannelInfo | null> {
    const youtube = google.youtube({ version: "v3", auth: this.createAuth(accessToken) });

    const response = await youtube.channels.list({
      part: ["snippet", "statistics"],
      id: [channelId],
    });

    const item = response.data.items?.[0];
    if (!item) return null;

    return {
      id: item.id!,
      title: item.snippet?.title ?? "",
      thumbnail: item.snippet?.thumbnails?.default?.url ?? null,
      subscriberCount: Number(item.statistics?.subscriberCount ?? 0),
      videoCount: Number(item.statistics?.videoCount ?? 0),
      viewCount: Number(item.statistics?.viewCount ?? 0),
    };
  }

  async getVideos(
    accessToken: string,
    channelId: string,
    maxResults = 50,
    pageToken?: string,
  ): Promise<{ videos: VideoInfo[]; nextPageToken?: string }> {
    const youtube = google.youtube({ version: "v3", auth: this.createAuth(accessToken) });

    const searchResponse = await youtube.search.list({
      part: ["id"],
      channelId,
      type: ["video"],
      order: "date",
      maxResults,
      pageToken,
    });

    const videoIds = (searchResponse.data.items ?? [])
      .map((item) => item.id?.videoId)
      .filter(Boolean) as string[];

    if (videoIds.length === 0) {
      return { videos: [], nextPageToken: undefined };
    }

    const videosResponse = await youtube.videos.list({
      part: ["snippet", "statistics"],
      id: videoIds,
    });

    const videos: VideoInfo[] = (videosResponse.data.items ?? []).map((item) => ({
      id: item.id!,
      title: item.snippet?.title ?? "",
      thumbnail: item.snippet?.thumbnails?.medium?.url ?? null,
      description: item.snippet?.description ?? null,
      publishedAt: item.snippet?.publishedAt ?? null,
      viewCount: Number(item.statistics?.viewCount ?? 0),
      likeCount: Number(item.statistics?.likeCount ?? 0),
      commentCount: Number(item.statistics?.commentCount ?? 0),
    }));

    return {
      videos,
      nextPageToken: searchResponse.data.nextPageToken ?? undefined,
    };
  }

  async getChannelAnalytics(
    accessToken: string,
    channelId: string,
    startDate: string,
    endDate: string,
  ): Promise<DailyAnalytics[]> {
    const analytics = google.youtubeAnalytics({
      version: "v2",
      auth: this.createAuth(accessToken),
    });

    const response = await analytics.reports.query({
      ids: `channel==${channelId}`,
      startDate,
      endDate,
      metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,impressions,annotationClickThroughRate,estimatedRevenue,likes,comments,shares",
      dimensions: "day",
      sort: "day",
    });

    const rows = response.data.rows ?? [];
    return rows.map((row) => ({
      date: String(row[0]),
      views: Number(row[1] ?? 0),
      estimatedMinutesWatched: Number(row[2] ?? 0),
      averageViewDuration: Number(row[3] ?? 0),
      subscribersGained: Number(row[4] ?? 0),
      subscribersLost: Number(row[5] ?? 0),
      impressions: Number(row[6] ?? 0),
      ctr: Number(row[7] ?? 0),
      revenue: Number(row[8] ?? 0),
      likes: Number(row[9] ?? 0),
      comments: Number(row[10] ?? 0),
      shares: Number(row[11] ?? 0),
    }));
  }

  async getVideoAnalytics(
    accessToken: string,
    channelId: string,
    videoId: string,
    startDate: string,
    endDate: string,
  ): Promise<VideoAnalytics | null> {
    const analytics = google.youtubeAnalytics({
      version: "v2",
      auth: this.createAuth(accessToken),
    });

    const response = await analytics.reports.query({
      ids: `channel==${channelId}`,
      startDate,
      endDate,
      metrics: "views,estimatedMinutesWatched,averageViewDuration,likes,comments,shares,subscribersGained,subscribersLost,impressions,annotationClickThroughRate,estimatedRevenue",
      filters: `video==${videoId}`,
    });

    const row = response.data.rows?.[0];
    if (!row) return null;

    return {
      views: Number(row[0] ?? 0),
      estimatedMinutesWatched: Number(row[1] ?? 0),
      averageViewDuration: Number(row[2] ?? 0),
      likes: Number(row[3] ?? 0),
      comments: Number(row[4] ?? 0),
      shares: Number(row[5] ?? 0),
      subscribersGained: Number(row[6] ?? 0),
      subscribersLost: Number(row[7] ?? 0),
      impressions: Number(row[8] ?? 0),
      ctr: Number(row[9] ?? 0),
      revenue: Number(row[10] ?? 0),
    };
  }

  private createAuth(accessToken: string) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: accessToken });
    return auth;
  }
}
