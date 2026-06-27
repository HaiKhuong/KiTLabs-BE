import { Column, Entity, ManyToOne, JoinColumn } from "typeorm";

import { BaseEntity } from "../../../common/entities/base.entity";
import { YouTubeChannel } from "./youtube-channel.entity";

@Entity("analytics_snapshots")
export class AnalyticsSnapshot extends BaseEntity {
  @Column({ type: "date" })
  date!: string;

  @Column({ type: "bigint", default: 0 })
  views!: string;

  @Column({ type: "int", default: 0 })
  subscribers!: number;

  @Column({ name: "subscribers_gained", type: "int", default: 0 })
  subscribersGained!: number;

  @Column({ name: "subscribers_lost", type: "int", default: 0 })
  subscribersLost!: number;

  @Column({ name: "watch_time_hours", type: "decimal", precision: 10, scale: 2, default: 0 })
  watchTimeHours!: string;

  @Column({ type: "decimal", precision: 5, scale: 2, default: 0 })
  ctr!: string;

  @Column({ type: "bigint", default: 0 })
  impressions!: string;

  @Column({ name: "avg_view_duration", type: "int", default: 0 })
  avgViewDuration!: number;

  @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
  revenue!: string;

  @Column({ type: "int", default: 0 })
  likes!: number;

  @Column({ type: "int", default: 0 })
  comments!: number;

  @Column({ type: "int", default: 0 })
  shares!: number;

  @Column({ name: "channel_id", type: "uuid" })
  channelId!: string;

  @ManyToOne(() => YouTubeChannel, (channel) => channel.analyticsSnapshots)
  @JoinColumn({ name: "channel_id" })
  channel!: YouTubeChannel;
}
