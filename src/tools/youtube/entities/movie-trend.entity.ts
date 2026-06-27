import { Column, Entity, ManyToOne, JoinColumn } from "typeorm";

import { BaseEntity } from "../../../common/entities/base.entity";
import { Movie } from "./movie.entity";

@Entity("movie_trends")
export class MovieTrend extends BaseEntity {
  @Column({ type: "date" })
  date!: string;

  @Column({ name: "trend_score", type: "int", default: 0 })
  trendScore!: number;

  @Column({ name: "search_volume", type: "int", default: 0 })
  searchVolume!: number;

  @Column({ type: "varchar", length: 10, default: "VN" })
  region!: string;

  @Column({ type: "varchar", length: 500, nullable: true })
  keyword!: string | null;

  @Column({ name: "related_queries", type: "jsonb", nullable: true })
  relatedQueries!: Record<string, unknown> | null;

  @Column({ name: "movie_id", type: "uuid" })
  movieId!: string;

  @ManyToOne(() => Movie, (movie) => movie.trends)
  @JoinColumn({ name: "movie_id" })
  movie!: Movie;
}
