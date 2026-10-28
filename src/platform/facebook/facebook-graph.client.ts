import { Injectable, Logger } from "@nestjs/common";
import axios, { AxiosInstance } from "axios";
import { PlatformCredentialsService } from "../credentials/platform-credentials.service";

export type FacebookDebug = {
  isValid: boolean;
  appId?: string;
  userId?: string;
  scopes: string[];
  expiresAt?: Date;
  dataAccessExpiresAt?: Date;
  error?: string;
};

export type FacebookPageGrant = {
  id: string;
  name: string;
  accessToken: string;
  tasks: string[];
  pictureUrl?: string;
};

@Injectable()
export class FacebookGraphClient {
  private readonly logger = new Logger(FacebookGraphClient.name);
  private readonly http: AxiosInstance = axios.create({
    baseURL: "https://graph.facebook.com",
    timeout: 60_000,
  });

  constructor(private readonly creds: PlatformCredentialsService) {}

  private async graphVersion(): Promise<string> {
    const v = await this.creds.get("META_GRAPH_VERSION");
    return v || "v21.0";
  }

  async authorizationUrl(state: string): Promise<string> {
    const appId = await this.creds.require("META_APP_ID");
    const redirectUri = await this.creds.require("META_REDIRECT_URI");
    const scopes = await this.creds.get("META_SCOPES");
    const version = await this.graphVersion();
    const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
    url.searchParams.set("client_id", appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", scopes || "pages_show_list,pages_read_engagement,pages_manage_posts,publish_video");
    url.searchParams.set("response_type", "code");
    return url.toString();
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; expiresIn?: number }> {
    const version = await this.graphVersion();
    const appId = await this.creds.require("META_APP_ID");
    const appSecret = await this.creds.require("META_APP_SECRET");
    const redirectUri = await this.creds.require("META_REDIRECT_URI");
    const res = await this.http.get(`/${version}/oauth/access_token`, {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      },
    });
    return {
      accessToken: String(res.data?.access_token),
      expiresIn: res.data?.expires_in ? Number(res.data.expires_in) : undefined,
    };
  }

  async exchangeLongLived(shortLivedToken: string): Promise<{ accessToken: string; expiresIn?: number }> {
    const version = await this.graphVersion();
    const appId = await this.creds.require("META_APP_ID");
    const appSecret = await this.creds.require("META_APP_SECRET");
    const res = await this.http.get(`/${version}/oauth/access_token`, {
      params: {
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortLivedToken,
      },
    });
    return {
      accessToken: String(res.data?.access_token),
      expiresIn: res.data?.expires_in ? Number(res.data.expires_in) : undefined,
    };
  }

  async debugToken(inputToken: string): Promise<FacebookDebug> {
    const version = await this.graphVersion();
    const appId = await this.creds.require("META_APP_ID");
    const appSecret = await this.creds.require("META_APP_SECRET");
    const res = await this.http.get(`/${version}/debug_token`, {
      params: {
        input_token: inputToken,
        access_token: `${appId}|${appSecret}`,
      },
    });
    const data = res.data?.data ?? {};
    return {
      isValid: Boolean(data.is_valid),
      appId: data.app_id ? String(data.app_id) : undefined,
      userId: data.user_id ? String(data.user_id) : undefined,
      scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : [],
      expiresAt: data.expires_at ? new Date(Number(data.expires_at) * 1000) : undefined,
      dataAccessExpiresAt: data.data_access_expires_at ? new Date(Number(data.data_access_expires_at) * 1000) : undefined,
      error: data.error?.message ? String(data.error.message) : undefined,
    };
  }

  async getProfile(accessToken: string): Promise<{ id: string; name: string; pictureUrl?: string }> {
    const version = await this.graphVersion();
    const res = await this.http.get(`/${version}/me`, {
      params: {
        fields: "id,name,picture.width(100).height(100)",
        access_token: accessToken,
      },
    });
    return {
      id: String(res.data?.id),
      name: String(res.data?.name ?? ""),
      pictureUrl: res.data?.picture?.data?.url ? String(res.data.picture.data.url) : undefined,
    };
  }

  async listPages(userToken: string): Promise<FacebookPageGrant[]> {
    const version = await this.graphVersion();
    const pages: FacebookPageGrant[] = [];
    let nextUrl: string | null = `/${version}/me/accounts?fields=id,name,access_token,tasks,picture.width(100).height(100)&limit=100`;

    while (nextUrl) {
      const res: any = await this.http.get(nextUrl, {
        params: nextUrl.startsWith("http") ? undefined : { access_token: userToken },
      });
      const data = res.data?.data ?? [];
      for (const item of data) {
        pages.push({
          id: String(item.id),
          name: String(item.name ?? ""),
          accessToken: String(item.access_token ?? ""),
          tasks: Array.isArray(item.tasks) ? item.tasks.map(String) : [],
          pictureUrl: item.picture?.data?.url ? String(item.picture.data.url) : undefined,
        });
      }
      nextUrl = res.data?.paging?.next ? String(res.data.paging.next) : null;
    }
    return pages;
  }
}
