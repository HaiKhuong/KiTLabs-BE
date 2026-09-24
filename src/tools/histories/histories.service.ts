import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { existsSync, statSync } from "fs";
import { basename, dirname, extname, join } from "path";
import { DataSource } from "typeorm";

import { resolveTranslateWorkRoot } from "../../common/desktop/data-path";
import {
  HISTORY_SOFT_DELETE_TABLES,
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
  folderPath: string | null;
  previewText: string | null;
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
  preview_text: string | null;
  artifact_kind: string | null;
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
        SELECT id, source, name, completed_at, result_path, preview_text, artifact_kind
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

  async softDeleteHistory(userId: string, source: string, id: string): Promise<{ deleted: true }> {
    const trimmedUserId = userId?.trim();
    const trimmedId = id?.trim();
    if (!trimmedUserId) {
      throw new BadRequestException("userId is required");
    }
    if (!trimmedId) {
      throw new BadRequestException("id is required");
    }
    const sourceKey = this.resolveSourceFilter(source);
    if (sourceKey === "all") {
      throw new BadRequestException("source is required");
    }

    const tables = HISTORY_SOFT_DELETE_TABLES[sourceKey];
    for (const table of tables) {
      const updated = await this.dataSource.query<{ id: string }[]>(
        `UPDATE "${table}"
         SET deleted_at = NOW()
         WHERE id = $1::uuid AND user_id = $2::uuid AND deleted_at IS NULL
         RETURNING id`,
        [trimmedId, trimmedUserId],
      );
      if (Array.isArray(updated) && updated.length > 0) {
        return { deleted: true };
      }
    }

    throw new NotFoundException("History not found");
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

  private resolveExistingResultPath(resultPath: string): string {
    const trimmed = resultPath.trim();
    if (!trimmed) return "";
    if (existsSync(trimmed)) return trimmed;

    const slash = trimmed.replaceAll("\\", "/");
    const workRoot = resolveTranslateWorkRoot();
    const workspaceMatch = slash.match(/\/workspace\/([^/]+)(\/.*)?$/i);
    if (workspaceMatch?.[1]) {
      const restParts = (workspaceMatch[2] || "").split("/").filter(Boolean);
      const candidate =
        restParts.length > 0
          ? join(workRoot, workspaceMatch[1], ...restParts)
          : join(workRoot, workspaceMatch[1], "videos", `${workspaceMatch[1]}_vs_tm.mp4`);
      if (existsSync(candidate)) return candidate;
    }

    const fileName = basename(trimmed);
    const parentName = basename(slash.replace(/\/[^/]+$/, ""));
    if (fileName.toLowerCase().endsWith(".mp4")) {
      const byName = join(workRoot, parentName, "videos", fileName);
      if (existsSync(byName)) return byName;
    }
    return trimmed;
  }

  private isMp4File(path: string): boolean {
    return Boolean(path) && existsSync(path) && statSync(path).isFile() && extname(path).toLowerCase() === ".mp4";
  }

  private resolveMediaVideoPath(rawPath: string): string {
    const remapped = this.resolveExistingResultPath(rawPath);
    if (this.isMp4File(remapped)) return remapped;
    if (this.isMp4File(rawPath)) return rawPath;

    const anchors = [remapped, rawPath].filter((value) => value.trim().length > 0);
    for (const anchor of anchors) {
      const isDir = existsSync(anchor) && statSync(anchor).isDirectory();
      const dir = isDir ? anchor : dirname(anchor);
      const workName = basename(dir).toLowerCase() === "videos" ? basename(dirname(dir)) : basename(dir);
      const stem = basename(anchor, extname(anchor))
        .replace(/_voice$/i, "")
        .replace(/_tm$/i, "")
        .replace(/_vs_tm(_outro)?$/i, "");
      const names = [`${workName}_vs_tm.mp4`, `${workName}_vs_tm_outro.mp4`, `${stem}_vs_tm.mp4`];
      const dirs = [dir, join(dir, "videos"), dirname(dir), join(dirname(dir), "videos")];
      for (const folder of dirs) {
        for (const name of names) {
          const candidate = join(folder, name);
          if (this.isMp4File(candidate)) return candidate;
        }
      }
    }
    return remapped || rawPath;
  }

  private mapRow(row: UnifiedHistoryRawRow): UnifiedHistoryItemDto {
    const source = row.source as UnifiedHistorySource;
    const rawPath = typeof row.result_path === "string" ? row.result_path.trim() : "";
    const resultPath = source === "media" ? this.resolveMediaVideoPath(rawPath) : this.resolveExistingResultPath(rawPath);
    const playable =
      resultPath.length > 0 && existsSync(resultPath) && statSync(resultPath).isFile();
    const mediaKind: UnifiedHistoryMediaKind = source === "voice" ? "audio" : "video";
    const previewText =
      source === "voice" && typeof row.preview_text === "string" ? row.preview_text.trim() : "";

    const artifactKind = (row.artifact_kind || source) as string;
    let playUrl: string | null = null;
    if (playable) {
      switch (artifactKind) {
        case "media":
          playUrl = `/api/tools/translates/histories/${encodeURIComponent(row.id)}/video`;
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
        case "recap":
          playUrl = `/api/tools/recap/artifact?${new URLSearchParams({
            recapHistoryId: row.id,
            type: "video",
          }).toString()}`;
          break;
        case "narrato":
          playUrl = `/api/tools/narrato/artifact?${new URLSearchParams({
            narratoHistoryId: row.id,
            type: "video",
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
      folderPath: (resultPath || rawPath) ? dirname(resultPath || rawPath) : null,
      previewText: previewText || null,
    };
  }
}
