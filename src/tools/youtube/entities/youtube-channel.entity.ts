import { Column, Entity, ManyToOne, JoinColumn, OneToMany } from "typeorm";

import { BaseEntity } from "../../../common/entities/base.entity";
import { User } from "../../users/user.entity";
import { YouTubeVideo } from "./youtube-video.entity";
import { AnalyticsSnapshot } from "./analytics-snapshot.entity";

@Entity("youtube_channels")
export class YouTubeChannel extends BaseEntity {
  @Column({ name: "channel_id", type: "varchar", length: 50, unique: true })
  channelId!: string;

  @Column({ type: "varchar", length: 255 })
  name!: string;

  @Column({ type: "text", nullable: true })
  thumbnail!: string | null;

  @Column({ name: "subscriber_count", type: "int", default: 0 })
  subscriberCount!: number;

  @Column({ name: "video_count", type: "int", default: 0 })
  videoCount!: number;

  @Column({ name: "view_count", type: "bigint", default: 0 })
  viewCount!: string;

  @Column({ name: "google_access_token", type: "text", nullable: true })
  googleAccessToken!: string | null;

  @Column({ name: "google_refresh_token", type: "text", nullable: true })
  googleRefreshToken!: string | null;

  @Column({ name: "token_expires_at", type: "timestamptz", nullable: true })
  tokenExpiresAt!: Date | null;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: "user_id" })
  user!: User;

  @OneToMany(() => YouTubeVideo, (video) => video.channel)
  videos!: YouTubeVideo[];

  @OneToMany(() => AnalyticsSnapshot, (snapshot) => snapshot.channel)
  analyticsSnapshots!: AnalyticsSnapshot[];
}
