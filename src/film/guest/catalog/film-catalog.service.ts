import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, IsNull, LessThanOrEqual, MoreThanOrEqual } from "typeorm";
import { FilmMovieBannersQueryDto, FilmMoviesQueryDto } from "../../dto/film-catalog.dto";
import {
  FilmAdvertisement,
  FilmBanner,
  FilmComment,
  FilmEpisode,
  FilmEpisodeSource,
  FilmGenre,
  FilmMovie,
  FilmMovieGenre,
  FilmTag,
  FilmUser,
  FilmUserRole,
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

    if (query.sort === "views") {
      qb.orderBy("m.views", "DESC");
    } else if (query.sort === "favorited") {
      qb.orderBy(
        `(SELECT COUNT(*) FROM favorites favorite
          WHERE favorite.movie_id = m.id AND favorite.deleted_at IS NULL)`,
        "DESC",
      );
    } else {
      qb.orderBy("m.isHot", "DESC")
        .addOrderBy("m.ratingAvg", "DESC")
        .addOrderBy("m.rankScore", "DESC");
    }

    qb.addOrderBy("m.createdAt", "DESC");

    const [items, total] = await qb.take(take).skip(skip).getManyAndCount();

    return {
      items: await this.withGenres(items),
      total,
      page,
      limit: take,
    };
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

  async movieBanners(
    queryOrLimit?: FilmMovieBannersQueryDto | number,
    legacyRecommended: boolean | undefined = true,
  ) {
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
      this.db
        .getRepository(FilmUser)
        .find({ where: { role: FilmUserRole.GUEST }, order: { exp: "DESC" }, take: 20 }),
      this.db
        .getRepository(FilmMovie)
        .find({ order: { rankScore: "DESC" }, take: 20 }),
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
}

