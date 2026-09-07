import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { existsSync } from "fs";
import { DataSource } from "typeorm";

import {
  UNIFIED_HISTORY_DEFAULT_LIMIT,
  UNIFIED_HISTORY_MAX_LIMIT,
  UNIFIED_HISTORY_SOURCES,
  UNIFIED_HISTORY_UNION_SQL,
  type UnifiedHistorySource,
} from "./histories.constants";

export type UnifiedHistoryMediaKind = "video" | "audio";

export type UnifiedHistoryItemDto = {
  id: string;
  source: UnifiedHistorySource;
  name: string;
  completedAt: string;
  mediaKind: UnifiedHistoryMediaKind;
  playable: boolean;
  playUrl: string | null;
};

export type UnifiedHistoryPageDto = {
  items: UnifiedHistoryItemDto[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
};

type UnifiedHistoryRawRow = {
  id: string;
  source: string;
  name: string;
  completed_at: Date | string;
  result_path: string | null;
};

@Injectable()
export class HistoriesService {
  constructor(@InjectDataSource("tool") private readonly dataSource: DataSource) {}

  async listUnifiedHistories(
    userId: string,
    page = 1,
    limit = UNIFIED_HISTORY_DEFAULT_LIMIT,
    source = "all",
  ): Promise<UnifiedHistoryPageDto> {
    const trimmedUserId = userId?.trim();
    if (!trimmedUserId) {
      throw new BadRequestException("userId is required");
    }

    const currentPage = Math.max(1, Math.trunc(page) || 1);
    const take = Math.min(
      UNIFIED_HISTORY_MAX_LIMIT,
      Math.max(1, Math.trunc(limit) || UNIFIED_HISTORY_DEFAULT_LIMIT),
    );
    const skip = (currentPage - 1) * take;
    const sourceFilter = this.resolveSourceFilter(source);

    const countRows = await this.dataSource.query<{ total: string | number }[]>(
      `
        SELECT COUNT(*)::int AS total
        FROM (${UNIFIED_HISTORY_UNION_SQL}) AS unified
        WHERE ($2 = 'all' OR source = $2)
      `,
      [trimmedUserId, sourceFilter],
    );
    const total = Number(countRows?.[0]?.total ?? 0) || 0;

    const rows = await this.dataSource.query<UnifiedHistoryRawRow[]>(
      `
        SELECT id, source, name, completed_at, result_path
        FROM (${UNIFIED_HISTORY_UNION_SQL}) AS unified
        WHERE ($2 = 'all' OR source = $2)
        ORDER BY completed_at DESC
        LIMIT $3 OFFSET $4
      `,
      [trimmedUserId, sourceFilter, take, skip],
    );

    return {
      items: rows.map((row) => this.mapRow(row)),
      total,
      page: currentPage,
      limit: take,
      hasMore: skip + rows.length < total,
    };
  }

  private resolveSourceFilter(raw: string): "all" | UnifiedHistorySource {
    const key = String(raw ?? "all").trim();
    if (key === "all" || !key) return "all";
    if ((UNIFIED_HISTORY_SOURCES as readonly string[]).includes(key)) {
      return key as UnifiedHistorySource;
    }
    throw new BadRequestException(
      `source must be one of: all, ${UNIFIED_HISTORY_SOURCES.join(", ")}`,
    );
  }

  private mapRow(row: UnifiedHistoryRawRow): UnifiedHistoryItemDto {
    const source = row.source as UnifiedHistorySource;
    const resultPath = typeof row.result_path === "string" ? row.result_path.trim() : "";
    const playable = resultPath.length > 0 && existsSync(resultPath);
    const mediaKind: UnifiedHistoryMediaKind = source === "voice" ? "audio" : "video";

    let playUrl: string | null = null;
    if (playable) {
      switch (source) {
        case "media":
          playUrl = `/api/tools/translates/artifact?${new URLSearchParams({
            resultPath,
            type: "video",
          }).toString()}`;
          break;
        case "voice":
          playUrl = `/api/tools/audio/jobs/${encodeURIComponent(row.id)}/stream`;
          break;
        case "shortVideo":
          playUrl = `/api/tools/shortvideo/artifact?${new URLSearchParams({
            shortVideoHistoryId: row.id,
          }).toString()}`;
          break;
        case "whiteboard":
          playUrl = `/api/tools/whiteboard/artifact?${new URLSearchParams({
            whiteboardHistoryId: row.id,
          }).toString()}`;
          break;
        default:
          playUrl = null;
      }
    }

    return {
      id: row.id,
      source,
      name: row.name?.trim() || "Untitled",
      completedAt: new Date(row.completed_at).toISOString(),
      mediaKind,
      playable,
      playUrl,
    };
  }
}
