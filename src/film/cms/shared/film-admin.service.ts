import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, EntityTarget, In } from "typeorm";
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
  FilmMovie,
  FilmMovieGenre,
  FilmNotification,
  FilmRating,
  FilmTag,
  FilmUser,
  FilmUserInventory,
  FilmWatchHistory,
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
    filter?: { episodeId?: string; movieId?: string },
  ) {
    const repo = this.db.getRepository(this.target(resource));
    const take = Math.min(100, Math.max(1, limit));
    const skip = (Math.max(1, page) - 1) * take;

    const where: Record<string, unknown> = {};
    if (filter?.episodeId && (resource === "episode-sources" || resource === "episodes")) {
      where.episodeId = filter.episodeId;
    }
    if (filter?.movieId && (resource === "episodes" || resource === "movies")) {
      where.movieId = filter.movieId;
    }

    const [items, total] = await repo.findAndCount({
      where: Object.keys(where).length > 0 ? (where as never) : undefined,
      withDeleted: true,
      order: { createdAt: "DESC" } as never,
      take,
      skip,
    });

    if (resource === "movies") {
      const moviesWithGenres = await this.withGenres(items as FilmMovie[]);
      return { items: moviesWithGenres, total, page: Math.max(1, page), limit: take };
    }

    if (resource === "users") {
      const usersWithDevices = await this.withDevices(items as FilmUser[]);
      return { items: usersWithDevices, total, page: Math.max(1, page), limit: take };
    }

    return { items, total, page: Math.max(1, page), limit: take };
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

    return users.map((u) => ({
      ...u,
      device: u.deviceId ? deviceMap.get(u.deviceId) || null : null,
    }));
  }
}

