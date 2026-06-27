import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Movie } from "../entities/movie.entity";
import { MovieTrend } from "../entities/movie-trend.entity";
import { Recommendation } from "../entities/recommendation.entity";
import { CreateMovieDto, UpdateMovieDto, MovieFilterDto } from "../dto/movie.dto";

@Injectable()
export class MovieService {
  constructor(
    @InjectRepository(Movie, "tool")
    private readonly movieRepo: Repository<Movie>,
    @InjectRepository(MovieTrend, "tool")
    private readonly trendRepo: Repository<MovieTrend>,
    @InjectRepository(Recommendation, "tool")
    private readonly recRepo: Repository<Recommendation>,
  ) {}

  async findAll(userId: string, filter: MovieFilterDto): Promise<Movie[]> {
    const qb = this.movieRepo.createQueryBuilder("movie").where("movie.user_id = :userId", { userId });

    if (filter.status) {
      qb.andWhere("movie.status = :status", { status: filter.status });
    }

    if (filter.priority) {
      qb.andWhere("movie.priority = :priority", { priority: filter.priority });
    }

    if (filter.source) {
      qb.andWhere("movie.source ILIKE :source", { source: `%${filter.source}%` });
    }

    if (filter.tag) {
      qb.andWhere("movie.tags LIKE :tag", { tag: `%${filter.tag}%` });
    }

    if (filter.keyword) {
      qb.andWhere(
        "(movie.chinese_name ILIKE :keyword OR movie.vietnamese_name ILIKE :keyword)",
        { keyword: `%${filter.keyword}%` },
      );
    }

    return qb.orderBy("movie.score", "DESC").getMany();
  }

  async findOne(userId: string, id: string) {
    const movie = await this.movieRepo.findOne({ where: { id, userId } });
    if (!movie) throw new NotFoundException("Movie not found");

    const [trends, recommendations] = await Promise.all([
      this.trendRepo.find({
        where: { movieId: id },
        order: { date: "DESC" },
        take: 90,
      }),
      this.recRepo.find({
        where: { movieId: id },
        order: { generatedAt: "DESC" },
        take: 5,
      }),
    ]);

    return { ...movie, trends, recommendations };
  }

  async create(userId: string, dto: CreateMovieDto): Promise<Movie> {
    const movie = this.movieRepo.create({ ...dto, userId });
    return this.movieRepo.save(movie);
  }

  async update(userId: string, id: string, dto: UpdateMovieDto): Promise<Movie> {
    const movie = await this.movieRepo.findOne({ where: { id, userId } });
    if (!movie) throw new NotFoundException("Movie not found");

    Object.assign(movie, dto);
    return this.movieRepo.save(movie);
  }

  async delete(userId: string, id: string): Promise<void> {
    const movie = await this.movieRepo.findOne({ where: { id, userId } });
    if (!movie) throw new NotFoundException("Movie not found");
    await this.movieRepo.remove(movie);
  }
}
