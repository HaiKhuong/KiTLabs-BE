import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";

export enum VideoDownloadStatus {
  PENDING = "pending",
  DOWNLOADING = "downloading",
  COMPLETED = "completed",
  FAILED = "failed",
}

@Entity("video_downloads")
@Index(["userId", "awemeId"])
export class VideoDownload extends BaseEntity {
  @Column({ name: "user_id" })
  userId!: string;

  @ManyToOne(() => User, (user) => user.videoDownloads, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "order_number", type: "varchar", length: 10 })
  orderNumber!: string;

  @Column({ name: "aweme_id", type: "varchar", length: 100 })
  awemeId!: string;

  @Column({ name: "date", type: "varchar", length: 8 })
  date!: string;

  @Column({ name: "file_name", type: "varchar", length: 255 })
  fileName!: string;

  @Column({ name: "video_url", type: "text" })
  videoUrl!: string;

  @Column({ name: "description", type: "text", nullable: true })
  description!: string | null;

  @Column({
    type: "enum",
    enum: VideoDownloadStatus,
    default: VideoDownloadStatus.PENDING,
  })
  status!: VideoDownloadStatus;

  @Column({ name: "gopeed_task_id", type: "varchar", length: 100, nullable: true })
  gopeedTaskId!: string | null;

  @Column({ name: "downloaded_path", type: "varchar", length: 500, nullable: true })
  downloadedPath!: string | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;
}
