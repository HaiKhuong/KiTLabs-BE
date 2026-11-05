import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityTarget, In, IsNull, Not } from "typeorm";
import {
  DonationStatus,
  FilmActivityLog,
  FilmAdvertisement,
  FilmBanner,
  FilmChatMessage,
  FilmComment,
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
  FilmUserInventory,
  FilmWatchHistory,
  FilmImageUpload,
  FilmReport,
  FilmSetting,
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
};

@Injectable()
export class FilmAdminService {
  constructor(@InjectDataSource("film") private readonly db: DataSource) {}

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
    },
  ) {
    const repo = this.db.getRepository(this.target(resource));
    const take = Math.min(100, Math.max(1, limit));
    const skip = (Math.max(1, page) - 1) * take;

    if (resource === "movies") {
      return this.listMovies(page, take, skip, filter);
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
    const cleanData = { ...data };
    delete cleanData.genreIds;
    delete cleanData.genre_ids;
    delete cleanData.genres;

    if (resource === "episode-sources" && cleanData.isActive !== false) {
      return this.saveEpisodeSource(null, cleanData);
    }

    const repo = this.db.getRepository(this.target(resource));
    const created = await repo.save(repo.create(cleanData));

    if (resource === "movies" && Array.isArray(genreIds)) {
      await this.syncMovieGenres((created as any).id, genreIds);
      const [withG] = await this.withGenres([created as FilmMovie]);
      return withG;
    }

    return created;
  }

  async adminUpdate(resource: string, id: string, data: Record<string, unknown>) {
    const genreIds = (data.genreIds || data.genre_ids) as string[] | undefined;
    const cleanData = { ...data };
    delete cleanData.genreIds;
    delete cleanData.genre_ids;
    delete cleanData.genres;

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

    if (resource === "movies" && Array.isArray(genreIds)) {
      await this.syncMovieGenres(id, genreIds);
      const [withG] = await this.withGenres([saved as FilmMovie]);
      return withG;
    }

    return saved;
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
    const deviceIds = Array.from(
      new Set(users.map((u) => u.deviceId).filter((id): id is string => Boolean(id))),
    );

    if (!deviceIds.length) {
      return users.map((u) => ({ ...u, device: null }));
    }

    const devices = await this.db.getRepository(FilmDevice).find({
      where: { id: In(deviceIds) },
      withDeleted: true,
    });

    const deviceMap = new Map<string, FilmDevice>();
    devices.forEach((d) => deviceMap.set(d.id, d));

    return users.map((u) => {
      const device = u.deviceId ? deviceMap.get(u.deviceId) || null : null;
      return {
        ...u,
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
}

