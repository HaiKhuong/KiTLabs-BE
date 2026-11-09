import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityTarget, In, IsNull, Not } from "typeorm";
import { PlatformAdminRole } from "../../../platform/entities/platform-admin-role.entity";
import { PlatformAdminUser } from "../../../platform/entities/platform-admin-user.entity";
import {
  DonationStatus,
  FilmActivityLog,
  FilmAdvertisement,
  FilmBanner,
  FilmChatMessage,
  FilmComment,
  FilmCommentTemplate,
  FilmDevice,
  FilmDonation,
  FilmEpisode,
  FilmEpisodeSource,
  FilmFavorite,
  FilmGenre,
  FilmItem,
  FilmMission,
  FilmMovie,
  FilmMovieGenre,
  FilmNotification,
  FilmRating,
  FilmTag,
  FilmUser,
  FilmUserRole,
  FilmUserStatus,
  FilmUserInventory,
  FilmWatchHistory,
  FilmImageUpload,
  FilmReport,
  FilmSetting,
  ItemType,
  SectRank,
} from "../../entities/film.entities";
import { filmRankFor } from "../../shared/film-rank.util";

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
  "image-uploads": FilmImageUpload,
  reports: FilmReport,
  settings: FilmSetting,
  missions: FilmMission,
  "comment-templates": FilmCommentTemplate,
};

@Injectable()
export class FilmAdminService {
  constructor(
    @InjectDataSource("film") private readonly db: DataSource,
    @Optional() @InjectDataSource() private readonly platformDb?: DataSource,
  ) {}

  private target(resource: string) {
    const target = RESOURCES[resource];
    if (!target) throw new NotFoundException("Unknown film resource");
    return target;
  }

  async adminList(
    resource: string,
    page = 1,
    limit = 10,
    filter?: {
      episodeId?: string;
      movieId?: string;
      status?: string;
      deleted?: string;
      position?: string;
      search?: string;
      year?: number;
      genreId?: string;
      isHot?: string;
      isRecommended?: string;
      role?: string;
      reason?: string;
    },
  ) {
    const repo = this.db.getRepository(this.target(resource));
    const take = Math.min(100, Math.max(1, limit));
    const skip = (Math.max(1, page) - 1) * take;

    if (resource === "movies") {
      return this.listMovies(page, take, skip, filter);
    }
    if (resource === "users") {
      return this.listUsers(page, take, skip, filter);
    }
    if (resource === "comments") {
      return this.listComments(page, take, skip, filter);
    }
    if (resource === "reports") {
      return this.listReports(page, take, skip, filter);
    }

    const where: Record<string, unknown> = {};
    if (filter?.episodeId && (resource === "episode-sources" || resource === "episodes")) {
      where.episodeId = filter.episodeId;
    }
    if (filter?.movieId) {
      if (resource === "movies") {
        where.id = filter.movieId;
      } else if (resource === "episodes" || resource === "comments") {
        where.movieId = filter.movieId;
      }
    }
    if (filter?.status && (resource === "comments" || resource === "reports" || resource === "users")) {
      where.status = filter.status;
    }
    if (filter?.deleted === "true") {
      where.deletedAt = Not(IsNull());
    } else if (filter?.deleted === "all") {
      // withDeleted: true handles it
    } else {
      where.deletedAt = IsNull();
    }
    if (filter?.position && resource === "banners") {
      where.position = filter.position;
    }
    if (filter?.movieId && resource === "episode-sources") {
      const epRepo = this.db.getRepository(FilmEpisode);
      const eps = await epRepo.find({ where: { movieId: filter.movieId }, select: ["id"] });
      const epIds = eps.map((e) => e.id);
      if (epIds.length === 0) {
        return { items: [], total: 0, page: Math.max(1, page), limit: take };
      }
      where.episodeId = In(epIds);
    }

    const order = resource === "episodes"
      ? { episodeNumber: "ASC" }
      : resource === "episode-sources"
        ? { isActive: "DESC", priority: "ASC", createdAt: "DESC" }
        : { createdAt: "DESC" };
    const [items, total] = await repo.findAndCount({
      where: Object.keys(where).length > 0 ? (where as never) : undefined,
      withDeleted: true,
      order: order as never,
      take,
      skip,
    });

    if (resource === "users") {
      const usersWithDevices = await this.withDevices(items as FilmUser[]);
      return { items: usersWithDevices, total, page: Math.max(1, page), limit: take };
    }

    if (resource === "comments") {
      const commentsWithMeta = await this.withCommentMeta(items as FilmComment[]);
      return { items: commentsWithMeta, total, page: Math.max(1, page), limit: take };
    }

    return { items, total, page: Math.max(1, page), limit: take };
  }

  private async listMovies(
    page: number,
    take: number,
    skip: number,
    filter?: {
      status?: string;
      deleted?: string;
      search?: string;
      year?: number;
      genreId?: string;
      isHot?: string;
      isRecommended?: string;
    },
  ) {
    const query = this.db.getRepository(FilmMovie).createQueryBuilder("movie").withDeleted();
    if (filter?.deleted === "true") query.andWhere("movie.deletedAt IS NOT NULL");
    else if (filter?.deleted !== "all") query.andWhere("movie.deletedAt IS NULL");

    const search = filter?.search?.trim();
    if (search) {
      query.andWhere("(movie.title ILIKE :search OR movie.slug ILIKE :search)", { search: `%${search}%` });
    }
    if (filter?.year) query.andWhere("movie.releaseYear = :year", { year: filter.year });
    if (filter?.status) query.andWhere("movie.status = :status", { status: filter.status });
    if (filter?.isHot === "true" || filter?.isHot === "false") {
      query.andWhere("movie.isHot = :isHot", { isHot: filter.isHot === "true" });
    }
    if (filter?.isRecommended === "true" || filter?.isRecommended === "false") {
      query.andWhere("movie.isRecommended = :isRecommended", {
        isRecommended: filter.isRecommended === "true",
      });
    }
    if (filter?.genreId) {
      query.andWhere((subQuery) => {
        const exists = subQuery
          .subQuery()
          .select("1")
          .from(FilmMovieGenre, "movieGenre")
          .where("movieGenre.movieId = movie.id")
          .andWhere("movieGenre.genreId = :genreId")
          .getQuery();
        return `EXISTS ${exists}`;
      }).setParameter("genreId", filter.genreId);
    }

    const [movies, total] = await query
      .orderBy("movie.createdAt", "DESC")
      .skip(skip)
      .take(take)
      .getManyAndCount();
    return {
      items: await this.withGenres(movies),
      total,
      page: Math.max(1, page),
      limit: take,
    };
  }

  private async listUsers(
    page: number,
    take: number,
    skip: number,
    filter?: {
      status?: string;
      role?: string;
      search?: string;
      deleted?: string;
    },
  ) {
    const query = this.db.getRepository(FilmUser).createQueryBuilder("user").withDeleted();
    if (filter?.deleted === "true") query.andWhere("user.deletedAt IS NOT NULL");
    else if (filter?.deleted !== "all") query.andWhere("user.deletedAt IS NULL");

    const search = filter?.search?.trim();
    if (search) {
      query.andWhere(
        "(user.name ILIKE :search OR user.username ILIKE :search OR user.email ILIKE :search)",
        { search: `%${search}%` },
      );
    }
    if (filter?.status) {
      query.andWhere("user.status = :status", { status: filter.status });
    }
    if (filter?.role) {
      query.andWhere("user.role = :role", { role: filter.role });
    }

    const [users, total] = await query
      .orderBy("user.createdAt", "DESC")
      .skip(skip)
      .take(take)
      .getManyAndCount();

    const usersWithDevices = await this.withDevices(users);
    return {
      items: usersWithDevices,
      total,
      page: Math.max(1, page),
      limit: take,
    };
  }

  private async listComments(
    page: number,
    take: number,
    skip: number,
    filter?: {
      status?: string;
      movieId?: string;
      search?: string;
      deleted?: string;
    },
  ) {
    const query = this.db.getRepository(FilmComment).createQueryBuilder("comment").withDeleted();
    if (filter?.deleted === "true") query.andWhere("comment.deletedAt IS NOT NULL");
    else if (filter?.deleted !== "all") query.andWhere("comment.deletedAt IS NULL");

    if (filter?.status) {
      query.andWhere("comment.status = :status", { status: filter.status });
    }
    if (filter?.movieId) {
      query.andWhere("comment.movieId = :movieId", { movieId: filter.movieId });
    }

    const search = filter?.search?.trim();
    if (search) {
      query.leftJoin(FilmUser, "user", "user.id = comment.userId");
      query.leftJoin(FilmMovie, "movie", "movie.id = comment.movieId");
      query.andWhere(
        "(comment.content ILIKE :search OR user.name ILIKE :search OR user.username ILIKE :search OR user.email ILIKE :search OR movie.title ILIKE :search)",
        { search: `%${search}%` },
      );
    }

    const [comments, total] = await query
      .orderBy("comment.createdAt", "DESC")
      .skip(skip)
      .take(take)
      .getManyAndCount();

    const commentsWithMeta = await this.withCommentMeta(comments);
    return {
      items: commentsWithMeta,
      total,
      page: Math.max(1, page),
      limit: take,
    };
  }

  private async listReports(
    page: number,
    take: number,
    skip: number,
    filter?: {
      status?: string;
      reason?: string;
      movieId?: string;
      search?: string;
      deleted?: string;
    },
  ) {
    const query = this.db.getRepository(FilmReport).createQueryBuilder("report").withDeleted();
    if (filter?.deleted === "true") query.andWhere("report.deletedAt IS NOT NULL");
    else if (filter?.deleted !== "all") query.andWhere("report.deletedAt IS NULL");

    if (filter?.status) {
      query.andWhere("report.status = :status", { status: filter.status });
    }
    if (filter?.reason) {
      query.andWhere("report.reason = :reason", { reason: filter.reason });
    }
    if (filter?.movieId) {
      query.andWhere("report.movieId = :movieId", { movieId: filter.movieId });
    }

    const search = filter?.search?.trim();
    if (search) {
      query.andWhere(
        "(report.movieTitle ILIKE :search OR report.episodeTitle ILIKE :search OR report.description ILIKE :search OR report.reason ILIKE :search)",
        { search: `%${search}%` },
      );
    }

    const [reports, total] = await query
      .orderBy("report.createdAt", "DESC")
      .skip(skip)
      .take(take)
      .getManyAndCount();

    return {
      items: reports,
      total,
      page: Math.max(1, page),
      limit: take,
    };
  }

  async adminOne(resource: string, id: string) {
    const row = await this.db
      .getRepository(this.target(resource))
      .findOne({ where: { id } as never, withDeleted: true });

    if (!row) throw new NotFoundException();

    if (resource === "movies") {
      const [withG] = await this.withGenres([row as FilmMovie]);
      return withG;
    }

    if (resource === "users") {
      const [withD] = await this.withDevices([row as FilmUser]);
      return withD;
    }

    return row;
  }

  async syncMovieGenres(movieId: string, genreIds: string[]) {
    const mgRepo = this.db.getRepository(FilmMovieGenre);
    await mgRepo.delete({ movieId });

    if (genreIds && genreIds.length > 0) {
      const rows = genreIds.map((genreId) => mgRepo.create({ movieId, genreId }));
      await mgRepo.save(rows);
    }
  }

  async adminCreate(resource: string, data: Record<string, unknown>) {
    const genreIds = (data.genreIds || data.genre_ids) as string[] | undefined;
    const titleItemId = data.titleItemId as string | undefined;
    const cleanData = { ...data };
    delete cleanData.genreIds;
    delete cleanData.genre_ids;
    delete cleanData.genres;
    delete cleanData.titleItemId;

    if (resource === "episode-sources" && cleanData.isActive !== false) {
      return this.saveEpisodeSource(null, cleanData);
    }

    if (resource === "comments") {
      let adminUser = await this.db.getRepository(FilmUser).findOne({
        where: { role: FilmUserRole.ADMIN },
        order: { createdAt: "ASC" },
      });
      if (!adminUser) {
        adminUser = await this.db.getRepository(FilmUser).findOne({
          where: [{ username: "admin" }, { email: "admin@kitlabs.io" }],
        });
        if (adminUser) {
          adminUser.role = FilmUserRole.ADMIN;
          await this.db.getRepository(FilmUser).save(adminUser);
        }
      }
      if (!adminUser) {
        const newAdmin = this.db.getRepository(FilmUser).create({
          name: "Ban Quản Trị",
          username: "admin",
          email: "admin@kitlabs.io",
          role: FilmUserRole.ADMIN,
          sectRank: SectRank.THAN_HOANG,
          status: FilmUserStatus.ACTIVE,
        });
        adminUser = await this.db.getRepository(FilmUser).save(newAdmin);
      }

      if (cleanData.parentId || !cleanData.userId) {
        cleanData.userId = adminUser.id;
        cleanData.userSectRankSnapshot = adminUser.sectRank || "THAN_HOANG";
      }
      if (!cleanData.userSectRankSnapshot) {
        cleanData.userSectRankSnapshot = adminUser.sectRank || "THAN_HOANG";
      }
      if (!cleanData.status) {
        cleanData.status = "APPROVED";
      }
    }

    const repo = this.db.getRepository(this.target(resource));
    const created = await repo.save(repo.create(cleanData));

    if (resource === "users" && titleItemId) {
      return this.equipUserTitle((created as FilmUser).id, titleItemId);
    }

    if (resource === "movies" && Array.isArray(genreIds)) {
      await this.syncMovieGenres((created as any).id, genreIds);
      const [withG] = await this.withGenres([created as FilmMovie]);
      return withG;
    }

    return created;
  }

  async adminUpdate(resource: string, id: string, data: Record<string, unknown>) {
    const genreIds = (data.genreIds || data.genre_ids) as string[] | undefined;
    const titleItemId = data.titleItemId as string | undefined;
    const cleanData = { ...data };
    delete cleanData.genreIds;
    delete cleanData.genre_ids;
    delete cleanData.genres;
    delete cleanData.titleItemId;

    if (resource === "episode-sources") {
      return this.saveEpisodeSource(id, cleanData);
    }

    const repo = this.db.getRepository(this.target(resource));
    const row = await this.db
      .getRepository(this.target(resource))
      .findOne({ where: { id } as never, withDeleted: true });

    if (!row) throw new NotFoundException();

    Object.assign(row, cleanData, { id });
    const saved = await repo.save(row);

    if (resource === "users" && titleItemId) {
      return this.equipUserTitle(id, titleItemId);
    }

    if (resource === "movies" && Array.isArray(genreIds)) {
      await this.syncMovieGenres(id, genreIds);
      const [withG] = await this.withGenres([saved as FilmMovie]);
      return withG;
    }

    return saved;
  }

  private async equipUserTitle(userId: string, itemId: string) {
    return this.db.transaction(async (manager) => {
      const item = await manager.getRepository(FilmItem).findOne({
        where: { id: itemId, type: ItemType.TITLE },
      });
      if (!item) throw new BadRequestException("Danh hiệu không hợp lệ");

      const slug = String(item.assetConfig?.slug || "").trim();
      if (!slug) throw new BadRequestException("Item danh hiệu chưa cấu hình assetConfig.slug");
      const minExp = Number(item.assetConfig?.minExp);
      const rank = String(item.assetConfig?.rank || "") as SectRank;
      if (!Number.isFinite(minExp) || minExp < 0 || !Object.values(SectRank).includes(rank)) {
        throw new BadRequestException(
          "Item danh hiệu chưa cấu hình assetConfig.minExp hoặc assetConfig.rank hợp lệ",
        );
      }

      await manager
        .getRepository(FilmUserInventory)
        .createQueryBuilder("inventory")
        .update()
        .set({ isEquipped: false })
        .where("user_id = :userId", { userId })
        .andWhere("is_equipped = true")
        .andWhere(`item_id IN (SELECT id FROM items WHERE type = 'TITLE')`)
        .execute();

      const inventoryRepo = manager.getRepository(FilmUserInventory);
      let inventory = await inventoryRepo.findOne({
        where: { userId, itemId },
        withDeleted: true,
      });
      if (!inventory) {
        inventory = inventoryRepo.create({ userId, itemId, acquiredAt: new Date() });
      }
      inventory.isEquipped = true;
      inventory.deletedAt = null;
      await inventoryRepo.save(inventory);

      const userRepo = manager.getRepository(FilmUser);
      const user = await userRepo.findOne({ where: { id: userId }, withDeleted: true });
      if (!user) throw new NotFoundException();
      user.currentTitle = slug;
      user.exp = String(Math.floor(minExp));
      user.sectRank = rank;
      await userRepo.save(user);
      return user;
    });
  }

  async reorderEpisodes(movieId: string, episodeIds: string[]) {
    return this.db.transaction(async (manager) => {
      const repo = manager.getRepository(FilmEpisode);
      const episodes = await repo.find({ where: { movieId, id: In(episodeIds) } });
      if (episodes.length !== episodeIds.length) throw new NotFoundException("Episode not found in movie");
      // Use temporary negative values first to avoid the unique (movie_id, episode_number)
      // constraint while two existing episode numbers are being swapped.
      for (const [index, id] of episodeIds.entries()) {
        await repo.update({ id, movieId }, { episodeNumber: String(-(index + 1)) });
      }
      for (const [index, id] of episodeIds.entries()) {
        await repo.update({ id, movieId }, { episodeNumber: String(index + 1) });
      }
      return { reordered: true, episodeIds };
    });
  }

  private async saveEpisodeSource(id: string | null, data: Record<string, unknown>) {
    return this.db.transaction(async (manager) => {
      const repo = manager.getRepository(FilmEpisodeSource);
      const existing = id ? await repo.findOne({ where: { id }, withDeleted: true }) : null;
      if (id && !existing) throw new NotFoundException();
      const episodeId = String(data.episodeId || existing?.episodeId || "");

      if (data.isActive !== false) {
        await repo
          .createQueryBuilder()
          .update(FilmEpisodeSource)
          .set({ isActive: false })
          .where("episode_id = :episodeId", { episodeId })
          .andWhere(id ? "id <> :id" : "1 = 1", id ? { id } : {})
          .execute();
      }

      const row = existing || repo.create();
      Object.assign(row, data, { ...(id ? { id } : {}) });
      return repo.save(row);
    });
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
    return this.db.transaction(async (manager) => {
      const repo = manager.getRepository(FilmDonation);
      const donation = await repo
        .createQueryBuilder("d")
        .setLock("pessimistic_write")
        .where("d.id = :id", { id })
        .getOne();

      if (!donation) throw new NotFoundException();

      Object.assign(donation, data, { id: donation.id });

      if (donation.status === DonationStatus.SUCCESS && !donation.rewardAppliedAt) {
        const user = await manager
          .getRepository(FilmUser)
          .createQueryBuilder("u")
          .setLock("pessimistic_write")
          .where("u.id = :id", { id: donation.userId })
          .getOneOrFail();

        const amount = Number(donation.amountVnd);
        user.totalDonatedVnd = String(Number(user.totalDonatedVnd) + amount);
        user.spiritStones = String(BigInt(user.spiritStones) + BigInt(donation.spiritStonesConverted));
        user.exp = String(BigInt(user.exp) + BigInt(Math.floor(amount / 1000) * 100));
        user.sectRank = filmRankFor(Number(user.exp));
        donation.rewardAppliedAt = new Date();

        await manager.save(user);
      }

      return repo.save(donation);
    });
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
      genres: rows
        .filter((row) => row.movieId === movie.id)
        .map(({ id, name, slug }) => ({ id, name, slug })),
    }));
  }

  private async withDevices(users: FilmUser[]) {
    if (!users.length) return [];
    const userIds = users.map((user) => user.id);
    const equippedTitles = await this.db
      .getRepository(FilmUserInventory)
      .createQueryBuilder("inventory")
      .innerJoin(FilmItem, "item", "item.id = inventory.itemId")
      .select("inventory.userId", "userId")
      .addSelect("inventory.itemId", "itemId")
      .addSelect("item.assetConfig ->> 'slug'", "slug")
      .where("inventory.userId IN (:...userIds)", { userIds })
      .andWhere("inventory.isEquipped = true")
      .andWhere("item.type = :type", { type: ItemType.TITLE })
      .getRawMany<{ userId: string; itemId: string; slug: string | null }>();
    const titleMap = new Map(equippedTitles.map((title) => [title.userId, title]));
    const deviceIds = Array.from(
      new Set(users.map((u) => u.deviceId).filter((id): id is string => Boolean(id))),
    );

    const devices = deviceIds.length
      ? await this.db.getRepository(FilmDevice).find({
          where: { id: In(deviceIds) },
          withDeleted: true,
        })
      : [];

    const deviceMap = new Map<string, FilmDevice>();
    devices.forEach((d) => deviceMap.set(d.id, d));

    return users.map((u) => {
      const device = u.deviceId ? deviceMap.get(u.deviceId) || null : null;
      const equippedTitle = titleMap.get(u.id);
      return {
        ...u,
        currentTitle: equippedTitle?.slug || u.currentTitle,
        equippedTitleItemId: equippedTitle?.itemId || null,
        device,
        lastIp: device?.lastIp || device?.firstIp || null,
        lastUserAgent: device?.userAgent || null,
      };
    });
  }

  private async withCommentMeta(comments: FilmComment[]) {
    if (!comments.length) return [];

    const userIds = Array.from(new Set(comments.map((c) => c.userId).filter(Boolean)));
    const movieIds = Array.from(new Set(comments.map((c) => c.movieId).filter(Boolean)));
    const episodeIds = Array.from(
      new Set(comments.map((c) => c.episodeId).filter((id): id is string => Boolean(id))),
    );

    const userMap = new Map<string, Partial<FilmUser>>();
    if (userIds.length > 0) {
      const users = await this.db.getRepository(FilmUser).find({
        where: { id: In(userIds) },
        select: ["id", "name", "username", "email", "avatarUrl", "sectRank"],
        withDeleted: true,
      });
      users.forEach((u) => userMap.set(u.id, u));
    }

    const movieMap = new Map<string, Partial<FilmMovie>>();
    if (movieIds.length > 0) {
      const movies = await this.db.getRepository(FilmMovie).find({
        where: { id: In(movieIds) },
        select: ["id", "title", "slug", "bannerUrl", "thumbnailUrl"],
        withDeleted: true,
      });
      movies.forEach((m) => movieMap.set(m.id, m));
    }

    const episodeMap = new Map<string, Partial<FilmEpisode>>();
    if (episodeIds.length > 0) {
      const episodes = await this.db.getRepository(FilmEpisode).find({
        where: { id: In(episodeIds) },
        select: ["id", "episodeNumber", "title"],
        withDeleted: true,
      });
      episodes.forEach((e) => episodeMap.set(e.id, e));
    }

    return comments.map((c) => ({
      ...c,
      user: userMap.get(c.userId) || null,
      movie: movieMap.get(c.movieId) || null,
      episode: c.episodeId ? episodeMap.get(c.episodeId) || null : null,
    }));
  }

  async getMenuCounts(): Promise<Record<string, number>> {
    const [movies, genres, banners, missions, comments, reports, users, settings] = await Promise.all([
      this.db.getRepository(FilmMovie).count({ where: { deletedAt: IsNull() } }).catch(() => 0),
      this.db.getRepository(FilmGenre).count({ where: { deletedAt: IsNull() } }).catch(() => 0),
      this.db.getRepository(FilmBanner).count({ where: { deletedAt: IsNull() } }).catch(() => 0),
      this.db.getRepository(FilmMission).count({ where: { deletedAt: IsNull() } }).catch(() => 0),
      this.db.getRepository(FilmComment).count({ where: { deletedAt: IsNull() } }).catch(() => 0),
      this.db.getRepository(FilmReport).count({ where: { deletedAt: IsNull() } }).catch(() => 0),
      this.db.getRepository(FilmUser).count({ where: { deletedAt: IsNull() } }).catch(() => 0),
      this.db.getRepository(FilmSetting).count({ where: { deletedAt: IsNull() } }).catch(() => 0),
    ]);

    let adminUsers = 0;
    let roles = 0;
    if (this.platformDb) {
      try {
        adminUsers = await this.platformDb.getRepository(PlatformAdminUser).count({ where: { deletedAt: IsNull() } }).catch(() => 0);
        roles = await this.platformDb.getRepository(PlatformAdminRole).count({ where: { deletedAt: IsNull() } }).catch(() => 0);
      } catch {
        // Ignored if platform tables are not present
      }
    }

    return {
      movies,
      genres,
      banners,
      missions,
      comments,
      reports,
      users,
      settings,
      admin_users: adminUsers,
      roles,
      // Path aliases
      "/movies": movies,
      "/genres": genres,
      "/banners": banners,
      "/missions": missions,
      "/comments": comments,
      "/reports": reports,
      "/users": users,
      "/settings": settings,
      "/admin-users": adminUsers,
      "/roles": roles,
    };
  }

  async getCommentTemplates() {
    const repo = this.db.getRepository(FilmCommentTemplate);
    let items = await repo.find({
      where: { isActive: true, deletedAt: IsNull() },
      order: { displayOrder: "ASC", createdAt: "ASC" },
    });

    if (items.length === 0) {
      const defaultTemplates = [
        { type: "Khen phim", message: "Có mắt nhìn đấy, bổn tọa thích!" },
        { type: "Khen phim", message: "Đạo hữu cũng nghiện rồi à?" },
        { type: "Hóng tập mới", message: "Gấp gì? Tu tiên cần kiên nhẫn!" },
        { type: "Giục phim", message: "Giục nữa bổn tọa tẩu hỏa đấy!" },
        { type: "Giục phim", message: "Ngươi định ép bổn tọa phi thăng à?" },
        { type: "Phim quá cuốn", message: "Coi chừng nghiện, bổn tọa không cứu!" },
        { type: "Phim hài", message: "Cười ít thôi, rớt Kim Đan giờ!" },
        { type: "Chê phim", message: "Khẩu vị ngươi khó chiều thật!" },
        { type: "Báo lỗi", message: "Kẻ nào dám phá trận pháp của ta!" },
        { type: "Cảm ơn", message: "Miễn lễ, lui xuống cày phim tiếp!" },
        { type: "Xin thêm phim", message: "Tham lam! Nhưng bổn tọa thích!" },
        { type: "Bình luận vui", message: "Ngươi đến tu tiên hay tấu hài?" },
        { type: "Bình luận vui", message: "Lá gan không nhỏ đấy!" },
        { type: "Đòi phần tiếp", message: "Bổn tọa còn đang hóng hơn ngươi!" },
        { type: "Xem xuyên đêm", message: "Tu vi chưa tăng, thâm mắt đã tăng!" },
        { type: "Chào thành viên", message: "Vào Ma Vực rồi thì khó thoát lắm!" },
      ];
      const created = repo.create(
        defaultTemplates.map((t, idx) => ({
          ...t,
          displayOrder: idx + 1,
          isActive: true,
        })),
      );
      items = await repo.save(created);
    }

    return items;
  }
}

