import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, In } from "typeorm";
import { CreateFilmReportDto, FilmMovieBannersQueryDto, FilmMoviesQueryDto } from "./dto";
import {
  FilmAdvertisement,
  FilmBanner,
  FilmComment,
  FilmEpisode,
  FilmEpisodeSource,
  FilmGenre,
  FilmMovie,
  FilmMovieGenre,
  MovieStatus,
  FilmReport,
  FilmSetting,
  FilmTag,
  FilmUser,
  FilmUserRole,
  ReportStatus,
} from "../../entities/film.entities";

@Injectable()
export class FilmCatalogService {
  constructor(@InjectDataSource("film") private readonly db: DataSource) {}

  async publicMovies(query: FilmMoviesQueryDto) {
    const page = Math.max(1, query.page || 1);
    const take = Math.min(100, Math.max(1, query.limit || 20));
    const skip = (page - 1) * take;

    const qb = this.db.getRepository(FilmMovie).createQueryBuilder("m");

    if (query.search) {
      qb.andWhere("m.title ILIKE :q", { q: `%${query.search}%` });
    }

    if (query.hot !== undefined) {
      qb.andWhere("m.isHot = :hot", { hot: query.hot });
    }

    if (query.recommended !== undefined) {
      qb.andWhere("m.isRecommended = :recommended", { recommended: query.recommended });
    }

    if (query.excludeHiatus) {
      qb.andWhere("m.status != :hiatusStatus", { hiatusStatus: MovieStatus.HIATUS });
    }

    if (query.genre) {
      qb.andWhere(
        `EXISTS (
          SELECT 1
          FROM movie_genres mg
          INNER JOIN genres g ON g.id = mg.genre_id
          WHERE mg.movie_id = m.id AND g.slug = :genre
        )`,
        { genre: query.genre },
      );
    }

    if (query.sort === "newest") {
      this.orderByLatestEpisode(qb);
    } else if (query.sort === "hot") {
      qb.andWhere("m.isHot = :isHotSort", { isHotSort: true });
      qb.orderBy("m.createdAt", "DESC");
    } else if (query.sort === "views") {
      qb.orderBy("m.views", "DESC").addOrderBy("m.createdAt", "DESC");
    } else if (query.sort === "favorited") {
      if (query.favoritedUserId) {
        qb.andWhere(
          `EXISTS (
            SELECT 1
            FROM favorites favorite
            WHERE favorite.movie_id = m.id
              AND favorite.user_id = :favUserId
              AND favorite.deleted_at IS NULL
          )`,
          { favUserId: query.favoritedUserId },
        );
      } else {
        qb.andWhere("1 = 0");
      }
      qb.orderBy("m.createdAt", "DESC");
    } else {
      this.orderByLatestEpisode(qb);
    }

    const [items, total] = await qb.take(take).skip(skip).getManyAndCount();

    return {
      items: await this.withGenres(items),
      total,
      page,
      limit: take,
    };
  }

  private orderByLatestEpisode(qb: ReturnType<DataSource["createQueryBuilder"]>) {
    return qb
      .orderBy(
        `(SELECT MAX(episode.updated_at)
          FROM episodes episode
          WHERE episode.movie_id = m.id
            AND episode.deleted_at IS NULL)`,
        "DESC",
        "NULLS LAST",
      )
      .addOrderBy("m.createdAt", "DESC")
      .addOrderBy("m.id", "DESC");
  }

  async movie(slug: string) {
    const movie = await this.db.getRepository(FilmMovie).findOneBy({ slug });
    if (!movie) throw new NotFoundException();

    const episodes = await this.db
      .getRepository(FilmEpisode)
      .find({ where: { movieId: movie.id }, order: { episodeNumber: "ASC" } });

    const episodeSources = episodes.length
      ? await this.db.getRepository(FilmEpisodeSource).find({
          where: { episodeId: In(episodes.map((episode) => episode.id)), isActive: true },
          order: { priority: "ASC" },
        })
      : [];
    const sourcesByEpisodeId = new Map<string, FilmEpisodeSource[]>();

    for (const source of episodeSources) {
      const sources = sourcesByEpisodeId.get(source.episodeId) || [];
      sources.push(source);
      sourcesByEpisodeId.set(source.episodeId, sources);
    }

    const [result] = await this.withGenres([movie]);
    return {
      ...result,
      episodes: episodes.map((episode) => ({
        ...episode,
        sources: sourcesByEpisodeId.get(episode.id) || [],
      })),
    };
  }

  async movieBanners(queryOrLimit?: FilmMovieBannersQueryDto | number, legacyRecommended: boolean | undefined = true) {
    let limit = 6;
    let recommended: boolean | undefined = true;

    if (typeof queryOrLimit === "number") {
      limit = queryOrLimit;
      recommended = legacyRecommended;
    } else if (queryOrLimit) {
      limit = queryOrLimit.limit || 6;
      if (queryOrLimit.recommended === "all") {
        recommended = undefined;
      } else if (queryOrLimit.recommended === "false") {
        recommended = false;
      } else if (queryOrLimit.recommended === "true") {
        recommended = true;
      } else if (queryOrLimit.recommended === undefined) {
        recommended = true;
      }
    }

    const take = Math.min(10, Math.max(1, limit));
    const qb = this.db.getRepository(FilmMovie).createQueryBuilder("m");

    if (recommended !== undefined) {
      qb.where("m.isRecommended = :recommended", { recommended });
    }

    const movies = await qb
      .orderBy("m.isRecommended", "DESC")
      .addOrderBy("m.isHot", "DESC")
      .addOrderBy("m.rankScore", "DESC")
      .addOrderBy("m.createdAt", "DESC")
      .take(take)
      .getMany();

    return this.withGenres(movies);
  }

  genres(order: "ASC" | "DESC" = "DESC") {
    return this.db.getRepository(FilmGenre).find({ order: { createdAt: order } });
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
    return this.activeBannersQuery(now).orderBy("banner.displayOrder", "ASC").getMany();
  }

  popupBanner() {
    const now = new Date();
    return this.activeBannersQuery(now)
      .andWhere("banner.position = :position", { position: "POPUP" })
      .orderBy("banner.displayOrder", "ASC")
      .addOrderBy("banner.createdAt", "DESC")
      .getOne();
  }

  private activeBannersQuery(now: Date) {
    return this.db
      .getRepository(FilmBanner)
      .createQueryBuilder("banner")
      .where("banner.isActive = :isActive", { isActive: true })
      .andWhere("(banner.startTime IS NULL OR banner.startTime <= :now)", { now })
      .andWhere("(banner.endTime IS NULL OR banner.endTime >= :now)", { now });
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

  async comments(movieId: string, cursor?: string) {
    const qb = this.db
      .getRepository(FilmComment)
      .createQueryBuilder("c")
      .where("c.movieId = :movieId", { movieId })
      .andWhere("c.status = 'APPROVED'")
      .orderBy("c.createdAt", "DESC")
      .take(50);

    if (cursor) {
      qb.andWhere("c.createdAt < :cursor", { cursor: new Date(cursor) });
    }

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

  private async withGenres(movies: FilmMovie[]) {
    if (!movies.length) return [];
    const ids = movies.map((movie) => movie.id);

    const [rows, episodeCountRows] = await Promise.all([
      this.db
        .createQueryBuilder()
        .select("mg.movie_id", "movieId")
        .addSelect("g.id", "id")
        .addSelect("g.name", "name")
        .addSelect("g.slug", "slug")
        .from(FilmMovieGenre, "mg")
        .innerJoin(FilmGenre, "g", "g.id = mg.genre_id")
        .where("mg.movie_id IN (:...ids)", { ids })
        .getRawMany<{ movieId: string; id: string; name: string; slug: string }>(),
      this.db
        .createQueryBuilder()
        .select("episode.movie_id", "movieId")
        .addSelect("COUNT(DISTINCT episode.id)", "episodeCount")
        .from(FilmEpisode, "episode")
        .innerJoin(
          FilmEpisodeSource,
          "source",
          "source.episode_id = episode.id AND source.is_active = :sourceActive AND source.deleted_at IS NULL",
          { sourceActive: true },
        )
        .where("episode.movie_id IN (:...ids)", { ids })
        .andWhere("episode.deleted_at IS NULL")
        .groupBy("episode.movie_id")
        .getRawMany<{ movieId: string; episodeCount: string }>(),
    ]);
    const episodeCounts = new Map(episodeCountRows.map((row) => [row.movieId, Number(row.episodeCount)]));

    return movies.map((movie) => ({
      ...movie,
      currentEpisodeCount: episodeCounts.get(movie.id) ?? 0,
      genres: rows.filter((row) => row.movieId === movie.id).map(({ id, name, slug }) => ({ id, name, slug })),
    }));
  }

  async createReport(
    dto: CreateFilmReportDto,
    ipAddress?: string | null,
    userAgent?: string | null,
    user?: { userId?: string; deviceId?: string },
  ) {
    const movieRepo = this.db.getRepository(FilmMovie);
    const movie = await movieRepo.findOne({ where: { id: dto.movieId } });
    if (!movie) {
      throw new NotFoundException("Phim không tồn tại");
    }

    let episodeTitle = dto.episodeTitle || null;
    let episodeNumber = dto.episodeNumber !== undefined ? dto.episodeNumber : null;

    if (dto.episodeId) {
      const ep = await this.db.getRepository(FilmEpisode).findOne({ where: { id: dto.episodeId } });
      if (ep) {
        episodeTitle = ep.title || episodeTitle;
        episodeNumber = Number(ep.episodeNumber) || episodeNumber;
      }
    }

    const reportRepo = this.db.getRepository(FilmReport);
    const report = reportRepo.create({
      userId: user?.userId || null,
      deviceId: user?.deviceId || dto.deviceId || null,
      movieId: movie.id,
      movieTitle: movie.title,
      episodeId: dto.episodeId || null,
      episodeNumber,
      episodeTitle,
      pageUrl: dto.pageUrl || null,
      reason: dto.reason?.trim() || "VIDEO_ISSUE",
      description: dto.description?.trim() || null,
      status: ReportStatus.PENDING,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
    });

    await reportRepo.save(report);

    return {
      success: true,
      id: report.id,
      message: "Dị biến đã được truyền về Ma Vực! Chấp Sự sẽ sớm điều tra và khắc phục!",
    };
  }

  async publicSettings() {
    return this.db.getRepository(FilmSetting).find({
      where: { isPublic: true },
      order: { key: "ASC" },
    });
  }

  async publicSettingByKey(key: string) {
    const setting = await this.db.getRepository(FilmSetting).findOne({
      where: { key: key.trim(), isPublic: true },
    });
    if (!setting) throw new NotFoundException(`Cấu hình ${key} không tồn tại hoặc không công khai`);
    return setting;
  }
}
