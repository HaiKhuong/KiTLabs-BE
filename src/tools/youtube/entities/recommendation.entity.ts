import { Column, Entity, ManyToOne, JoinColumn } from "typeorm";

import { BaseEntity } from "../../../common/entities/base.entity";
import { Movie } from "./movie.entity";

export enum RecommendationPriority {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
  CRITICAL = "critical",
}

@Entity("recommendations")
export class Recommendation extends BaseEntity {
  @Column({ type: "decimal", precision: 5, scale: 2 })
  score!: string;

  @Column({ type: "enum", enum: RecommendationPriority, default: RecommendationPriority.MEDIUM })
  priority!: RecommendationPriority;

  @Column({ type: "text" })
  reason!: string;

  @Column({ type: "text", nullable: true })
  risk!: string | null;

  @Column({ name: "expected_views", type: "varchar", length: 100, nullable: true })
  expectedViews!: string | null;

  @Column({ name: "expected_ctr", type: "varchar", length: 50, nullable: true })
  expectedCtr!: string | null;

  @Column({ name: "generated_at", type: "timestamptz" })
  generatedAt!: Date;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @Column({ name: "batch_id", type: "varchar", length: 50, nullable: true })
  batchId!: string | null;

  @Column({ name: "movie_id", type: "uuid" })
  movieId!: string;

  @ManyToOne(() => Movie, (movie) => movie.recommendations)
  @JoinColumn({ name: "movie_id" })
  movie!: Movie;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;
}
