import { Column, Entity, ManyToOne, JoinColumn } from "typeorm";

import { BaseEntity } from "../../../common/entities/base.entity";
import { YouTubeChannel } from "./youtube-channel.entity";

@Entity("youtube_videos")
export class YouTubeVideo extends BaseEntity {
  @Column({ name: "video_id", type: "varchar", length: 50, unique: true })
  videoId!: string;

  @Column({ type: "varchar", length: 500 })
  title!: string;

  @Column({ type: "text", nullable: true })
  thumbnail!: string | null;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  @Column({ name: "published_at", type: "timestamptz", nullable: true })
  publishedAt!: Date | null;

  @Column({ type: "bigint", default: 0 })
  views!: string;

  @Column({ type: "int", default: 0 })
  likes!: number;

  @Column({ type: "int", default: 0 })
  comments!: number;

  @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
  ctr!: string;

  @Column({ name: "watch_time_hours", type: "decimal", precision: 10, scale: 2, default: 0 })
  watchTimeHours!: string;

  @Column({ name: "avg_view_duration", type: "int", default: 0 })
  avgViewDuration!: number;

  @Column({ type: "bigint", default: 0 })
  impressions!: string;

  @Column({ type: "decimal", precision: 5, scale: 2, nullable: true })
  score!: string | null;

  @Column({ name: "channel_id", type: "uuid" })
  channelId!: string;

  @ManyToOne(() => YouTubeChannel, (channel) => channel.videos)
  @JoinColumn({ name: "channel_id" })
  channel!: YouTubeChannel;
}
