import { Column, Entity, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { TikTokAccount } from "./tiktok-account.entity";
import { CommercialDisclosure, TikTokVideoMetadata, TikTokVideoStatus } from "./tiktok.types";

@Entity("tiktok_videos")
export class TikTokVideo extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "account_id", type: "uuid", nullable: true })
  accountId!: string | null;

  @ManyToOne(() => TikTokAccount, (account) => account.videos, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "account_id" })
  account!: TikTokAccount | null;

  @Column({ name: "local_path", type: "text" })
  localPath!: string;

  @Column({ name: "original_file_name", type: "varchar", length: 255 })
  originalFileName!: string;

  @Column({ name: "file_size", type: "bigint" })
  fileSize!: string;

  @Column({ type: "jsonb" })
  metadata!: TikTokVideoMetadata;

  @Column({ type: "enum", enum: TikTokVideoStatus, default: TikTokVideoStatus.IMPORTED })
  status!: TikTokVideoStatus;

  @Column({ type: "varchar", length: 2200, nullable: true })
  caption!: string | null;

  @Column({ name: "privacy_level", type: "varchar", length: 64, nullable: true })
  privacyLevel!: string | null;

  @Column({
    name: "commercial_disclosure",
    type: "enum",
    enum: CommercialDisclosure,
    default: CommercialDisclosure.NONE,
  })
  commercialDisclosure!: CommercialDisclosure;

  @Column({ name: "is_aigc", default: false })
  isAigc!: boolean;

  @Column({ name: "disable_comment", default: true })
  disableComment!: boolean;

  @Column({ name: "disable_duet", default: true })
  disableDuet!: boolean;

  @Column({ name: "disable_stitch", default: true })
  disableStitch!: boolean;

  @Column({ name: "publish_id", type: "varchar", length: 255, nullable: true })
  publishId!: string | null;

  @Column({ name: "provider_post_id", type: "varchar", length: 255, nullable: true })
  providerPostId!: string | null;

  @Column({ name: "uploaded_bytes", type: "bigint", default: "0" })
  uploadedBytes!: string;

  @Column({ name: "queue_job_id", type: "varchar", length: 255, nullable: true })
  queueJobId!: string | null;

  @Column({ name: "error_code", type: "varchar", length: 100, nullable: true })
  errorCode!: string | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;

  @Column({ name: "published_at", type: "timestamptz", nullable: true })
  publishedAt!: Date | null;
}
