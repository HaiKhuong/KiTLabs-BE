import { Injectable, Logger } from "@nestjs/common";
import axios, { AxiosInstance } from "axios";
import { PlatformCredentialsService } from "../credentials/platform-credentials.service";

export type TikTokTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  refresh_expires_in: number;
  open_id: string;
  scope: string;
};

export type TikTokUserProfile = {
  openId: string;
  unionId?: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
};

export type TikTokCreatorProfile = {
  creator_username?: string;
  creator_nickname?: string;
  creator_avatar_url?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
};

@Injectable()
export class TikTokApiClient {
  private readonly logger = new Logger(TikTokApiClient.name);
  private readonly http: AxiosInstance = axios.create({
    baseURL: process.env.TIKTOK_API_BASE_URL ?? "https://open.tiktokapis.com",
    timeout: 30_000,
  });

  constructor(private readonly creds: PlatformCredentialsService) {}

  async authorizationUrl(state: string): Promise<string> {
    const clientKey = await this.creds.require("TIKTOK_CLIENT_KEY");
    const redirectUri = await this.creds.require("TIKTOK_REDIRECT_URI");
    const scopes = await this.creds.get("TIKTOK_SCOPES");
    const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
    url.searchParams.set("client_key", clientKey);
    url.searchParams.set("scope", scopes || "user.info.basic,video.publish,video.list");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<TikTokTokenResponse> {
    const clientKey = await this.creds.require("TIKTOK_CLIENT_KEY");
    const clientSecret = await this.creds.require("TIKTOK_CLIENT_SECRET");
    const redirectUri = await this.creds.require("TIKTOK_REDIRECT_URI");
    const res = await this.http.post(
      "/v2/oauth/token/",
      new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    return res.data?.data ?? res.data;
  }

  async refreshToken(refreshToken: string): Promise<TikTokTokenResponse> {
    const clientKey = await this.creds.require("TIKTOK_CLIENT_KEY");
    const clientSecret = await this.creds.require("TIKTOK_CLIENT_SECRET");
    const res = await this.http.post(
      "/v2/oauth/token/",
      new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    return res.data?.data ?? res.data;
  }

  async revoke(accessToken: string): Promise<void> {
    const clientKey = await this.creds.require("TIKTOK_CLIENT_KEY");
    const clientSecret = await this.creds.require("TIKTOK_CLIENT_SECRET");
    await this.http.post(
      "/v2/oauth/revoke/",
      new URLSearchParams({
        client_key: clientKey,
        client_secret: clientSecret,
        token: accessToken,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
  }

  async getUser(accessToken: string): Promise<TikTokUserProfile> {
    const res = await this.http.get("/v2/user/info/", {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { fields: "open_id,union_id,avatar_url,display_name,username" },
    });
    const user = res.data?.data?.user ?? {};
    return {
      openId: user.open_id ? String(user.open_id) : "",
      unionId: user.union_id ? String(user.union_id) : undefined,
      username: user.username ? String(user.username) : undefined,
      displayName: user.display_name ? String(user.display_name) : undefined,
      avatarUrl: user.avatar_url ? String(user.avatar_url) : undefined,
    };
  }

  async creatorInfo(accessToken: string): Promise<TikTokCreatorProfile> {
    const res = await this.http.post(
      "/v2/post/publish/creator_info/query/",
      {},
      { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } },
    );
    return (res.data?.data ?? {}) as TikTokCreatorProfile;
  }
}

