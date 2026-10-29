import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityManager } from "typeorm";
import { FilmChatMessage } from "../../entities/film.entities";

@Injectable()
export class FilmChatService {
  constructor(@InjectDataSource("film") private readonly db: DataSource) {}

  async chatHistory(room: string, cursor?: string) {
    const qb = this.db
      .getRepository(FilmChatMessage)
      .createQueryBuilder("m")
      .where("m.roomChannel = :room", { room })
      .orderBy("m.createdAt", "DESC")
      .take(50);

    if (cursor) {
      qb.andWhere("m.createdAt < :cursor", { cursor: new Date(cursor) });
    }

    const messages = await qb.getMany();
    const snapshots = await this.currentChatUserSnapshots(messages.map((message) => message.userId));

    return messages.map((message) => ({
      ...message,
      userSnapshot: snapshots.get(message.userId) ?? message.userSnapshot,
    }));
  }

  createChat(userId: string, roomChannel: string, message: string) {
    return this.db.transaction(async (manager) => {
      const snapshots = await this.currentChatUserSnapshots([userId], manager);
      const userSnapshot = snapshots.get(userId);
      if (!userSnapshot) throw new NotFoundException("User not found");

      return manager.save(
        manager.create(FilmChatMessage, {
          userId,
          roomChannel,
          message,
          userSnapshot,
        }),
      );
    });
  }

  private async currentChatUserSnapshots(userIds: string[], manager: EntityManager = this.db.manager) {
    const uniqueUserIds = [...new Set(userIds)];
    if (uniqueUserIds.length === 0) return new Map<string, Record<string, unknown>>();

    const rows = await manager.query<
      Array<{
        id: string;
        name: string;
        avatarUrl: string | null;
        currentTitle: string | null;
        frameUrl: string | null;
      }>
    >(
      `SELECT u.id,
              u.name,
              u.avatar_url AS "avatarUrl",
              COALESCE(title.asset_config->>'slug', u.current_title) AS "currentTitle",
              frame.image_url AS "frameUrl"
       FROM users u
       LEFT JOIN LATERAL (
         SELECT i.asset_config
         FROM user_inventories ui
         INNER JOIN items i ON i.id = ui.item_id
         WHERE ui.user_id = u.id
           AND ui.is_equipped = true
           AND i.type = 'TITLE'
         ORDER BY ui.acquired_at DESC, ui.updated_at DESC
         LIMIT 1
       ) title ON true
       LEFT JOIN LATERAL (
         SELECT i.image_url
         FROM user_inventories ui
         INNER JOIN items i ON i.id = ui.item_id
         WHERE ui.user_id = u.id
           AND ui.is_equipped = true
           AND i.type = 'AVATAR_FRAME'
         ORDER BY ui.acquired_at DESC, ui.updated_at DESC
         LIMIT 1
       ) frame ON true
       WHERE u.id = ANY($1::uuid[])`,
      [uniqueUserIds],
    );

    return new Map(
      rows.map((row) => [
        row.id,
        {
          name: row.name,
          avatarUrl: row.avatarUrl,
          currentTitle: row.currentTitle,
          frameUrl: row.frameUrl,
        },
      ]),
    );
  }
}

