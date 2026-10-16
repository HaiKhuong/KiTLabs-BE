import { Injectable } from "@nestjs/common";
import axios, { AxiosError, AxiosInstance } from "axios";
import { createReadStream, statSync } from "fs";
import { open } from "fs/promises";

import { classifyFacebookFailure } from "./facebook-retry";

export class FacebookProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly uncertain: boolean,
    readonly permission: boolean,
    readonly httpStatus?: number,
    readonly detail?: string,
  ) {
    super("Facebook provider request failed");
  }
}

export type FacebookToken = { accessToken: string; expiresIn: number | null };
export type FacebookProfile = { id: string; name: string; pictureUrl: string | null };
export type FacebookPageGrant = {
  id: string;
  name: string;
  accessToken: string;
  tasks: string[];
  pictureUrl: string | null;
};
export type FacebookDebug = {
  isValid: boolean;
  scopes: string[];
  expiresAt: Date | null;
  userId: string | null;
};

type GraphErrorBody = { error?: { message?: string; code?: number; fbtrace_id?: string } };

@Injectable()
export class FacebookProviderAdapter {
  private readonly http: AxiosInstance = axios.create({
    baseURL: `https://graph.facebook.com/${this.version()}`,
    timeout: Number(process.env.META_HTTP_TIMEOUT_MS ?? 60_000),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  authorizationUrl(state: string): string {
    const url = new URL(`https://www.facebook.com/${this.version()}/dialog/oauth`);
    url.search = new URLSearchParams({
      client_id: this.required("META_APP_ID"),
      redirect_uri: this.required("META_REDIRECT_URI"),
      state,
      response_type: "code",
      scope: process.env.META_SCOPES ??
        "pages_show_list,pages_read_engagement,pages_manage_posts,pages_manage_engagement",
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string): Promise<FacebookToken> {
    const data = await this.get<{ access_token?: string; expires_in?: number }>("/oauth/access_token", undefined, {
      client_id: this.required("META_APP_ID"),
      client_secret: this.required("META_APP_SECRET"),
      redirect_uri: this.required("META_REDIRECT_URI"),
      code,
    });
    if (!data.access_token) throw new FacebookProviderError("TOKEN_MISSING", false, false, false);
    return { accessToken: data.access_token, expiresIn: data.expires_in ?? null };
  }

  async exchangeLongLived(token: string): Promise<FacebookToken> {
    const data = await this.get<{ access_token?: string; expires_in?: number }>("/oauth/access_token", undefined, {
      grant_type: "fb_exchange_token",
      client_id: this.required("META_APP_ID"),
      client_secret: this.required("META_APP_SECRET"),
      fb_exchange_token: token,
    });
    if (!data.access_token) throw new FacebookProviderError("TOKEN_MISSING", false, false, false);
    return { accessToken: data.access_token, expiresIn: data.expires_in ?? null };
  }

  async debugToken(inputToken: string): Promise<FacebookDebug> {
    const data = await this.get<{
      data?: {
        is_valid?: boolean;
        scopes?: string[];
        granular_scopes?: Array<{ scope?: string }>;
        expires_at?: number;
        user_id?: string;
      };
    }>("/debug_token", undefined, {
      input_token: inputToken,
      access_token: `${this.required("META_APP_ID")}|${this.required("META_APP_SECRET")}`,
    });
    const payload = data.data ?? {};
    const scopes = new Set<string>(payload.scopes ?? []);
    for (const item of payload.granular_scopes ?? []) {
      if (item.scope) scopes.add(item.scope);
    }
    const expiresAt = payload.expires_at && payload.expires_at > 0 ? new Date(payload.expires_at * 1000) : null;
    return {
      isValid: payload.is_valid === true,
      scopes: [...scopes],
      expiresAt,
      userId: payload.user_id ?? null,
    };
  }

  async getProfile(userToken: string): Promise<FacebookProfile> {
    const data = await this.get<{ id?: string; name?: string; picture?: { data?: { url?: string } } }>(
      "/me",
      userToken,
      { fields: "id,name,picture.type(large)" },
    );
    if (!data.id) throw new FacebookProviderError("PROFILE_MISSING", false, false, false);
    return { id: data.id, name: data.name ?? "Facebook", pictureUrl: data.picture?.data?.url ?? null };
  }

  async listPages(userToken: string): Promise<FacebookPageGrant[]> {
    const grants: FacebookPageGrant[] = [];
    let next: string | null = `https://graph.facebook.com/${this.version()}/me/accounts`;
    let params: Record<string, string> | undefined = {
      fields: "id,name,access_token,tasks,picture{url}",
      limit: "100",
    };
    type PageList = {
      data?: Array<{
        id?: string;
        name?: string;
        access_token?: string;
        tasks?: string[];
        picture?: { data?: { url?: string } };
      }>;
      paging?: { next?: string };
    };
    for (let page = 0; page < 10 && next; page += 1) {
      const data: PageList = await this.getAbsolute<PageList>(next, userToken, params);
      params = undefined;
      for (const item of data.data ?? []) {
        if (!item.id || !item.access_token) continue;
        grants.push({
          id: item.id,
          name: item.name ?? item.id,
          accessToken: item.access_token,
          tasks: item.tasks ?? [],
          pictureUrl: item.picture?.data?.url ?? null,
        });
      }
      next = data.paging?.next ?? null;
    }
    return grants;
  }

  async publishFeed(pageToken: string, pageId: string, message: string): Promise<{ id: string }> {
    const data = await this.postForm<{ id?: string }>(`/${pageId}/feed`, pageToken, { message });
    if (!data.id) throw new FacebookProviderError("POST_ID_MISSING", false, true, false);
    return { id: data.id };
  }

  async publishPhoto(pageToken: string, pageId: string, filePath: string, caption: string): Promise<{ id: string }> {
    const bytes = await readSlice(filePath, 0, statSync(filePath).size);
    const form = new FormData();
    form.append("caption", caption);
    form.append("published", "true");
    form.append("source", new Blob([Uint8Array.from(bytes)]), "photo.jpg");
    const data = await this.postMultipart<{ id?: string; post_id?: string }>(`/${pageId}/photos`, pageToken, form);
    const id = data.post_id || data.id;
    if (!id) throw new FacebookProviderError("POST_ID_MISSING", false, true, false);
    return { id };
  }

  async startVideo(
    pageToken: string,
    pageId: string,
    fileSize: number,
  ): Promise<{ videoId: string; uploadSessionId: string; startOffset: number; endOffset: number }> {
    const data = await this.postVideoForm<{
      video_id?: string;
      upload_session_id?: string;
      start_offset?: string;
      end_offset?: string;
    }>(`/${pageId}/videos`, pageToken, {
      upload_phase: "start",
      file_size: String(fileSize),
    });
    if (!data.video_id || !data.upload_session_id) {
      throw new FacebookProviderError("UPLOAD_SESSION_MISSING", false, true, false);
    }
    return {
      videoId: data.video_id,
      uploadSessionId: data.upload_session_id,
      startOffset: Number(data.start_offset ?? 0),
      endOffset: Number(data.end_offset ?? 0),
    };
  }

  async transferVideo(input: {
    pageToken: string;
    pageId: string;
    uploadSessionId: string;
    filePath: string;
    startOffset: number;
    endOffset: number;
  }): Promise<{ startOffset: number; endOffset: number }> {
    const start = input.startOffset;
    const end = Math.max(start, input.endOffset);
    const bytes = await readSlice(input.filePath, start, end);
    const form = new FormData();
    form.append("upload_phase", "transfer");
    form.append("upload_session_id", input.uploadSessionId);
    form.append("start_offset", String(start));
    form.append("video_file_chunk", new Blob([Uint8Array.from(bytes)]), "chunk.bin");
    const data = await this.postVideoMultipart<{ start_offset?: string; end_offset?: string }>(
      `/${input.pageId}/videos`,
      input.pageToken,
      form,
    );
    return {
      startOffset: Number(data.start_offset ?? end),
      endOffset: Number(data.end_offset ?? end),
    };
  }

  async finishVideo(
    pageToken: string,
    pageId: string,
    uploadSessionId: string,
    title: string,
    description: string,
  ): Promise<void> {
    await this.postVideoForm(`/${pageId}/videos`, pageToken, {
      upload_phase: "finish",
      upload_session_id: uploadSessionId,
      title,
      description,
    });
  }

  async startReel(pageToken: string, pageId: string): Promise<{ videoId: string; uploadUrl: string }> {
    const data = await this.postForm<{ video_id?: string; upload_url?: string }>(`/${pageId}/video_reels`, pageToken, {
      upload_phase: "start",
    });
    if (!data.video_id || !data.upload_url) {
      throw new FacebookProviderError("REEL_SESSION_MISSING", false, true, false);
    }
    return { videoId: data.video_id, uploadUrl: data.upload_url };
  }

  async uploadReel(uploadUrl: string, pageToken: string, filePath: string, fileSize: number): Promise<void> {
    try {
      await axios.post(uploadUrl, createReadStream(filePath), {
        headers: {
          Authorization: `OAuth ${pageToken}`,
          offset: "0",
          file_size: String(fileSize),
          "Content-Type": "application/octet-stream",
          "Content-Length": String(fileSize),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: Number(process.env.META_UPLOAD_TIMEOUT_MS ?? 1_800_000),
      });
    } catch (error) {
      throw this.asProviderError(error);
    }
  }

  async finishReel(pageToken: string, pageId: string, videoId: string, description: string): Promise<void> {
    await this.postForm(`/${pageId}/video_reels`, pageToken, {
      upload_phase: "finish",
      video_id: videoId,
      video_state: "PUBLISHED",
      description,
    });
  }

  async comment(pageToken: string, objectId: string, message: string): Promise<{ id: string }> {
    const data = await this.postForm<{ id?: string }>(`/${objectId}/comments`, pageToken, { message });
    if (!data.id) throw new FacebookProviderError("COMMENT_ID_MISSING", false, true, false);
    return { id: data.id };
  }

  private version(): string {
    return process.env.META_GRAPH_VERSION ?? "v21.0";
  }

  private async get<T>(path: string, token: string | undefined, params: Record<string, string>): Promise<T> {
    try {
      const response = await this.http.get<T>(path, { params, headers: token ? this.auth(token) : undefined });
      return response.data;
    } catch (error) {
      throw this.asProviderError(error);
    }
  }

  private async getAbsolute<T>(url: string, token: string, params?: Record<string, string>): Promise<T> {
    try {
      const response = await axios.get<T>(url, {
        params,
        headers: this.auth(token),
        timeout: Number(process.env.META_HTTP_TIMEOUT_MS ?? 60_000),
      });
      return response.data;
    } catch (error) {
      throw this.asProviderError(error);
    }
  }

  private async postForm<T>(path: string, token: string, body: Record<string, string>): Promise<T> {
    try {
      const response = await this.http.post<T>(path, new URLSearchParams(body), {
        headers: { ...this.auth(token), "Content-Type": "application/x-www-form-urlencoded" },
      });
      return this.assertNoGraphError(response.data);
    } catch (error) {
      throw this.asProviderError(error);
    }
  }

  private async postMultipart<T>(path: string, token: string, form: FormData): Promise<T> {
    try {
      const response = await this.http.post<T>(path, form, { headers: this.auth(token) });
      return this.assertNoGraphError(response.data);
    } catch (error) {
      throw this.asProviderError(error);
    }
  }

  private async postVideoForm<T>(path: string, token: string, body: Record<string, string>): Promise<T> {
    try {
      const response = await axios.post<T>(`https://graph-video.facebook.com/${this.version()}${path}`, new URLSearchParams(body), {
        headers: { ...this.auth(token), "Content-Type": "application/x-www-form-urlencoded" },
        timeout: Number(process.env.META_UPLOAD_TIMEOUT_MS ?? 1_800_000),
        maxBodyLength: Infinity,
      });
      return this.assertNoGraphError(response.data);
    } catch (error) {
      throw this.asProviderError(error);
    }
  }

  private async postVideoMultipart<T>(path: string, token: string, form: FormData): Promise<T> {
    try {
      const response = await axios.post<T>(`https://graph-video.facebook.com/${this.version()}${path}`, form, {
        headers: this.auth(token),
        timeout: Number(process.env.META_UPLOAD_TIMEOUT_MS ?? 1_800_000),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      return this.assertNoGraphError(response.data);
    } catch (error) {
      throw this.asProviderError(error);
    }
  }

  private assertNoGraphError<T>(data: T): T {
    const graph = (data as GraphErrorBody).error;
    if (graph?.code) {
      const classified = classifyFacebookFailure({ hasResponse: true, graphCode: graph.code });
      throw new FacebookProviderError(classified.code, classified.retryable, classified.uncertain, classified.permission, undefined, graph.message);
    }
    return data;
  }

  private asProviderError(error: unknown): FacebookProviderError {
    if (error instanceof FacebookProviderError) return error;
    const axiosError = error as AxiosError<GraphErrorBody>;
    const graph = axiosError.response?.data?.error;
    const classified = classifyFacebookFailure({
      hasResponse: Boolean(axiosError.response),
      httpStatus: axiosError.response?.status,
      graphCode: graph?.code,
    });
    return new FacebookProviderError(
      classified.code,
      classified.retryable,
      classified.uncertain,
      classified.permission,
      axiosError.response?.status,
      graph?.message,
    );
  }

  private auth(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  private required(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new FacebookProviderError("NOT_CONFIGURED", false, false, false, undefined, name);
    return value;
  }
}

async function readSlice(filePath: string, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, end - start);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer;
  } finally {
    await handle.close();
  }
}
