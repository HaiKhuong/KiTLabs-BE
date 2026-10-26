import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityManager, EntityTarget, IsNull, LessThanOrEqual, MoreThanOrEqual } from "typeorm";
import {
  DonationStatus,
  FilmActivityLog,
  FilmAdvertisement,
  FilmBanner,
  FilmChatMessage,
  FilmComment,
  FilmDevice,
  FilmCommentReaction,
  FilmDonation,
  FilmEpisode,
  FilmEpisodeSource,
  FilmFavorite,
  FilmGenre,
  FilmItem,
  FilmMovie,
  FilmMovieGenre,
  FilmMovieTag,
  FilmNotification,
  FilmRating,
  FilmTag,
  FilmUser,
  FilmUserInventory,
  FilmUserRole,
  FilmWatchHistory,
  ReactionType,
  SectRank,
} from "./entities/film.entities";

const RESOURCES: Record<string, EntityTarget<object>> = {
  movies: FilmMovie,
  genres: FilmGenre,
  tags: FilmTag,
  episodes: FilmEpisode,
  "episode-sources": FilmEpisodeSource,
  items: FilmItem,
  banners: FilmBanner,
  advertisements: FilmAdvertisement,
  notifications: FilmNotification,
  users: FilmUser,
  devices: FilmDevice,
  donations: FilmDonation,
  "activity-logs": FilmActivityLog,
  "chat-messages": FilmChatMessage,
  "watch-histories": FilmWatchHistory,
  favorites: FilmFavorite,
  ratings: FilmRating,
  comments: FilmComment,
  inventories: FilmUserInventory,
};
export const filmRankFor = (exp: number): SectRank =>
  exp >= 1_000_000
    ? SectRank.THAN_HOANG
    : exp >= 200_000
      ? SectRank.LUAN_HOI
      : exp >= 50_000
        ? SectRank.HOA_THAN
        : exp >= 20_000
          ? SectRank.NGUYEN_ANH
          : exp >= 5_000
            ? SectRank.KIM_DAN
            : exp >= 1_000
              ? SectRank.TRUC_CO
              : SectRank.LUYEN_KHI;

@Injectable()
export class FilmService {
  constructor(@InjectDataSource("film") private readonly db: DataSource) {}
  private target(resource: string) {
    const target = RESOURCES[resource];
    if (!target) throw new NotFoundException("Unknown film resource");
    return target;
  }
  async adminList(resource: string, page = 1, limit = 20) {
    const repo = this.db.getRepository(this.target(resource));
    const take = Math.min(100, Math.max(1, limit));
    const [items, total] = await repo.findAndCount({
      withDeleted: true,
      order: { createdAt: "DESC" } as never,
      take,
      skip: (Math.max(1, page) - 1) * take,
    });
    return { items, total, page: Math.max(1, page), limit: take };
  }
  async adminOne(resource: string, id: string) {
    const row = await this.db
      .getRepository(this.target(resource))
      .findOne({ where: { id } as never, withDeleted: true });
    if (!row) throw new NotFoundException();
    return row;
  }
  async adminCreate(resource: string, data: Record<string, unknown>) {
    return this.db.getRepository(this.target(resource)).save(this.db.getRepository(this.target(resource)).create(data));
  }
  async adminUpdate(resource: string, id: string, data: Record<string, unknown>) {
    const repo = this.db.getRepository(this.target(resource));
    const row = await this.adminOne(resource, id);
    Object.assign(row, data, { id });
    return repo.save(row);
  }
  async adminDelete(resource: string, id: string) {
    await this.adminOne(resource, id);
    await this.db.getRepository(this.target(resource)).softDelete(id);
    return { deleted: true };
  }
  async adminRestore(resource: string, id: string) {
    await this.adminOne(resource, id);
    await this.db.getRepository(this.target(resource)).restore(id);
    return { restored: true };
  }

  async updateDonation(id: string, data: Record<string, unknown>) {
    return this.db.transaction(async (m) => {
      const repo = m.getRepository(FilmDonation);
      const donation = await repo
        .createQueryBuilder("d")
        .setLock("pessimistic_write")
        .where("d.id=:id", { id })
        .getOne();
      if (!donation) throw new NotFoundException();
      Object.assign(donation, data, { id: donation.id });
      if (donation.status === DonationStatus.SUCCESS && !donation.rewardAppliedAt) {
        const user = await m
          .getRepository(FilmUser)
          .createQueryBuilder("u")
          .setLock("pessimistic_write")
          .where("u.id=:id", { id: donation.userId })
          .getOneOrFail();
        const amount = Number(donation.amountVnd);
        user.totalDonatedVnd = String(Number(user.totalDonatedVnd) + amount);
        user.spiritStones = String(BigInt(user.spiritStones) + BigInt(donation.spiritStonesConverted));
        user.exp = String(BigInt(user.exp) + BigInt(Math.floor(amount / 1000) * 100));
        user.sectRank = filmRankFor(Number(user.exp));
        donation.rewardAppliedAt = new Date();
        await m.save(user);
      }
      return repo.save(donation);
    });
  }

  async publicMovies(query: {
    page?: number;
    limit?: number;
    search?: string;
    hot?: boolean;
    recommended?: boolean;
    genre?: string;
    sort?: string;
  }) {
    const page = Math.max(1, query.page || 1),
      take = Math.min(100, Math.max(1, query.limit || 20));
    const qb = this.db.getRepository(FilmMovie).createQueryBuilder("m");
    if (query.search) qb.andWhere("(m.title ILIKE :q OR m.originalTitle ILIKE :q)", { q: `%${query.search}%` });
    if (query.hot !== undefined) qb.andWhere("m.isHot=:hot", { hot: query.hot });
    if (query.recommended !== undefined)
      qb.andWhere("m.isRecommended=:recommended", { recommended: query.recommended });
    if (query.genre)
      qb.andWhere(
        `EXISTS (
          SELECT 1
          FROM movie_genres mg
          INNER JOIN genres g ON g.id = mg.genre_id
          WHERE mg.movie_id = m.id AND g.slug = :genre
        )`,
        { genre: query.genre },
      );

    if (query.sort === "views") {
      qb.orderBy("m.views", "DESC");
    } else if (query.sort === "favorited") {
      qb.orderBy(
        `(SELECT COUNT(*) FROM favorites favorite
          WHERE favorite.movie_id = m.id AND favorite.deleted_at IS NULL)`,
        "DESC",
      );
    } else {
      qb.orderBy("m.isHot", "DESC").addOrderBy("m.ratingAvg", "DESC").addOrderBy("m.rankScore", "DESC");
    }
    qb.addOrderBy("m.createdAt", "DESC");
    const [items, total] = await qb
      .take(take)
      .skip((page - 1) * take)
      .getManyAndCount();
    return { items: await this.withGenres(items), total, page, limit: take };
  }
  async movie(slug: string) {
    const movie = await this.db.getRepository(FilmMovie).findOneBy({ slug });
    if (!movie) throw new NotFoundException();
    const episodes = await this.db
      .getRepository(FilmEpisode)
      .find({ where: { movieId: movie.id }, order: { episodeNumber: "ASC" } });
    const [result] = await this.withGenres([movie]);
    return { ...result, episodes };
  }
  async movieBanners(limit?: number) {
    const take = Math.min(10, Math.max(1, limit || 6));
    const movies = await this.db
      .getRepository(FilmMovie)
      .createQueryBuilder("m")
      .where("m.isRecommended = true OR m.isHot = true")
      .orderBy("m.isRecommended", "DESC")
      .addOrderBy("m.isHot", "DESC")
      .addOrderBy("m.rankScore", "DESC")
      .addOrderBy("m.createdAt", "DESC")
      .take(take)
      .getMany();
    return this.withGenres(movies);
  }
  genres() {
    return this.db.getRepository(FilmGenre).find({ order: { name: "ASC" } });
  }
  tags() {
    return this.db.getRepository(FilmTag).find({ order: { name: "ASC" } });
  }
  sources(episodeId: string) {
    return this.db
      .getRepository(FilmEpisodeSource)
      .find({ where: { episodeId, isActive: true }, order: { priority: "ASC" } });
  }
  banners() {
    const now = new Date();
    return this.db.getRepository(FilmBanner).find({
      where: [
        { isActive: true, startTime: IsNull(), endTime: IsNull() },
        { isActive: true, startTime: LessThanOrEqual(now), endTime: MoreThanOrEqual(now) },
      ],
      order: { displayOrder: "ASC" },
    });
  }
  advertisements() {
    return this.db.getRepository(FilmAdvertisement).find({ where: { isActive: true } });
  }
  leaderboards() {
    return Promise.all([
      this.db
        .getRepository(FilmUser)
        .find({ where: { role: FilmUserRole.GUEST }, order: { totalDonatedVnd: "DESC" }, take: 20 }),
      this.db.getRepository(FilmUser).find({ where: { role: FilmUserRole.GUEST }, order: { exp: "DESC" }, take: 20 }),
      this.db.getRepository(FilmMovie).find({ order: { rankScore: "DESC" }, take: 20 }),
    ]).then(([donors, cultivators, movies]) => ({ donors, cultivators, movies }));
  }

  async saveWatch(
    userId: string,
    input: { movieId: string; episodeId: string; stoppedAtSeconds: number; watchedMinutes: number },
  ) {
    return this.db.transaction(async (m) => {
      const repo = m.getRepository(FilmWatchHistory);
      let row = await repo
        .createQueryBuilder("w")
        .setLock("pessimistic_write")
        .where("w.userId=:userId AND w.episodeId=:episodeId", { userId, episodeId: input.episodeId })
        .getOne();
      const before = row?.watchedMinutes || 0;
      const next = Math.max(before, input.watchedMinutes);
      if (!row)
        row = repo.create({
          userId,
          movieId: input.movieId,
          episodeId: input.episodeId,
          stoppedAtSeconds: input.stoppedAtSeconds,
          watchedMinutes: next,
        });
      else Object.assign(row, { stoppedAtSeconds: input.stoppedAtSeconds, watchedMinutes: next });
      const delta = next - before;
      if (delta > 0) {
        const user = await m
          .getRepository(FilmUser)
          .createQueryBuilder("u")
          .setLock("pessimistic_write")
          .where("u.id=:userId", { userId })
          .getOneOrFail();
        user.totalViewMinutes = String(BigInt(user.totalViewMinutes) + BigInt(delta));
        user.exp = String(BigInt(user.exp) + BigInt(delta * 10));
        user.sectRank = filmRankFor(Number(user.exp));
        await m.save(user);
      }
      return repo.save(row);
    });
  }
  history(userId: string) {
    return this.db.getRepository(FilmWatchHistory).find({ where: { userId }, order: { updatedAt: "DESC" } });
  }
  async favorite(userId: string, movieId: string) {
    const repo = this.db.getRepository(FilmFavorite);
    const old = await repo.findOne({ where: { userId, movieId }, withDeleted: true });
    if (old) {
      if (old.deletedAt) {
        await repo.restore(old.id);
        return { favorite: true };
      }
      await repo.softDelete(old.id);
      return { favorite: false };
    }
    await repo.save(repo.create({ userId, movieId }));
    return { favorite: true };
  }
  favorites(userId: string) {
    return this.db.getRepository(FilmFavorite).find({ where: { userId }, order: { createdAt: "DESC" } });
  }
  async rate(userId: string, input: { movieId: string; score: number; review?: string }) {
    if (input.score < 1 || input.score > 5) throw new BadRequestException("score must be 1..5");
    await this.db.getRepository(FilmRating).upsert({ userId, ...input }, ["userId", "movieId"]);
    const stats = await this.db
      .getRepository(FilmRating)
      .createQueryBuilder("r")
      .select("AVG(r.score)", "avg")
      .addSelect("COUNT(*)", "count")
      .where("r.movieId=:id", { id: input.movieId })
      .getRawOne<{ avg: string; count: string }>();
    await this.db.getRepository(FilmMovie).update(input.movieId, {
      ratingAvg: String(Number(stats?.avg || 0).toFixed(2)),
      ratingCount: Number(stats?.count || 0),
    });
    return this.db.getRepository(FilmRating).findOneBy({ userId, movieId: input.movieId });
  }
  async comment(
    userId: string,
    input: { movieId: string; episodeId?: string; parentId?: string; content: string; isSpoil?: boolean },
  ) {
    const user = await this.db.getRepository(FilmUser).findOneByOrFail({ id: userId });
    return this.db
      .getRepository(FilmComment)
      .save(this.db.getRepository(FilmComment).create({ ...input, userId, userSectRankSnapshot: user.sectRank }));
  }
  async comments(movieId: string, cursor?: string) {
    const qb = this.db
      .getRepository(FilmComment)
      .createQueryBuilder("c")
      .where("c.movieId=:movieId", { movieId })
      .andWhere("c.status='APPROVED'")
      .orderBy("c.createdAt", "DESC")
      .take(50);
    if (cursor) qb.andWhere("c.createdAt < :cursor", { cursor: new Date(cursor) });
    const comments = await qb.getMany();
    const userIds = [...new Set(comments.map((comment) => comment.userId))];
    const users = userIds.length
      ? await this.db
          .getRepository(FilmUser)
          .createQueryBuilder("u")
          .where("u.id IN (:...userIds)", { userIds })
          .getMany()
      : [];
    const usersById = new Map(users.map((user) => [user.id, user]));
    return comments.map((comment) => {
      const author = usersById.get(comment.userId);
      return {
        ...comment,
        author: author
          ? {
              id: author.id,
              name: author.name,
              avatarUrl: author.avatarUrl,
              sectRank: author.sectRank,
              currentTitle: author.currentTitle,
            }
          : null,
      };
    });
  }
  async react(userId: string, commentId: string, type: ReactionType) {
    return this.db.transaction(async (m) => {
      const repo = m.getRepository(FilmCommentReaction);
      const old = await repo.findOneBy({ userId, commentId });
      if (old?.type === type) {
        await repo.delete({ userId, commentId });
      } else await repo.save(repo.create({ userId, commentId, type }));
      const counts = await repo
        .createQueryBuilder("r")
        .select("r.type", "type")
        .addSelect("COUNT(*)", "count")
        .where("r.commentId=:commentId", { commentId })
        .groupBy("r.type")
        .getRawMany<{ type: ReactionType; count: string }>();
      await m.getRepository(FilmComment).update(commentId, {
        likesCount: Number(counts.find((x) => x.type === ReactionType.LIKE)?.count || 0),
        dislikesCount: Number(counts.find((x) => x.type === ReactionType.DISLIKE)?.count || 0),
      });
      return { type: old?.type === type ? null : type };
    });
  }
  inventory(userId: string) {
    return this.db.getRepository(FilmUserInventory).find({ where: { userId } });
  }
  notifications(userId: string) {
    return this.db
      .getRepository(FilmNotification)
      .find({ where: [{ userId }, { userId: IsNull() }], order: { createdAt: "DESC" } });
  }
  donations(userId: string) {
    return this.db.getRepository(FilmDonation).find({ where: { userId }, order: { createdAt: "DESC" } });
  }
  logActivity(
    userId: string,
    deviceId: string | null,
    data: Partial<FilmActivityLog> & { action: string },
    ip: string | null,
    userAgent: string | null,
  ) {
    const repo = this.db.getRepository(FilmActivityLog);
    return repo.save(repo.create({ ...data, userId, deviceId, ipAddress: ip, userAgent }));
  }
  async chatHistory(room: string, cursor?: string) {
    const qb = this.db
      .getRepository(FilmChatMessage)
      .createQueryBuilder("m")
      .where("m.roomChannel=:room", { room })
      .orderBy("m.createdAt", "DESC")
      .take(50);
    if (cursor) qb.andWhere("m.createdAt < :cursor", { cursor: new Date(cursor) });
    const messages = await qb.getMany();
    const snapshots = await this.currentChatUserSnapshots(messages.map((message) => message.userId));

    return messages.map((message) => ({
      ...message,
      userSnapshot: snapshots.get(message.userId) ?? message.userSnapshot,
    }));
  }
  createChat(userId: string, roomChannel: string, message: string) {
    return this.db.transaction(async (m) => {
      const snapshots = await this.currentChatUserSnapshots([userId], m);
      const userSnapshot = snapshots.get(userId);
      if (!userSnapshot) throw new NotFoundException("User not found");

      return m.save(
        m.create(FilmChatMessage, {
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

  private async withGenres(movies: FilmMovie[]) {
    if (!movies.length) return [];
    const ids = movies.map((movie) => movie.id);
    const rows = await this.db
      .createQueryBuilder()
      .select("mg.movie_id", "movieId")
      .addSelect("g.id", "id")
      .addSelect("g.name", "name")
      .addSelect("g.slug", "slug")
      .from(FilmMovieGenre, "mg")
      .innerJoin(FilmGenre, "g", "g.id = mg.genre_id")
      .where("mg.movie_id IN (:...ids)", { ids })
      .getRawMany<{ movieId: string; id: string; name: string; slug: string }>();
    return movies.map((movie) => ({
      ...movie,
      genres: rows.filter((row) => row.movieId === movie.id).map(({ id, name, slug }) => ({ id, name, slug })),
    }));
  }
}
