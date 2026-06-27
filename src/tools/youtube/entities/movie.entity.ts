import { Column, Entity, OneToMany } from "typeorm";

import { BaseEntity } from "../../../common/entities/base.entity";
import { MovieTrend } from "./movie-trend.entity";
import { Recommendation } from "./recommendation.entity";

export enum MovieStatus {
  PENDING = "pending",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  PUBLISHED = "published",
  CANCELLED = "cancelled",
}

export enum MoviePriority {
  LOW = "low",
  MEDIUM = "medium",
  HIGH = "high",
  URGENT = "urgent",
}

@Entity("movies")
export class Movie extends BaseEntity {
  @Column({ name: "chinese_name", type: "varchar", length: 500 })
  chineseName!: string;

  @Column({ name: "vietnamese_name", type: "varchar", length: 500, nullable: true })
  vietnameseName!: string | null;

  @Column({ type: "enum", enum: MovieStatus, default: MovieStatus.PENDING })
  status!: MovieStatus;

  @Column({ type: "varchar", length: 255, nullable: true })
  source!: string | null;

  @Column({ type: "int", default: 1 })
  episodes!: number;

  @Column({ name: "current_episode", type: "int", default: 0 })
  currentEpisode!: number;

  @Column({ type: "enum", enum: MoviePriority, default: MoviePriority.MEDIUM })
  priority!: MoviePriority;

  @Column({ type: "simple-array", nullable: true })
  tags!: string[] | null;

  @Column({ type: "text", nullable: true })
  notes!: string | null;

  @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
  score!: string;

  @Column({ name: "trend_score", type: "decimal", precision: 5, scale: 2, default: 0 })
  trendScore!: string;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @OneToMany(() => MovieTrend, (trend) => trend.movie)
  trends!: MovieTrend[];

  @OneToMany(() => Recommendation, (rec) => rec.movie)
  recommendations!: Recommendation[];
}
