import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { QueueJobStatus } from "../../common/enums/domain.enums";
import { User } from "../users/user.entity";

@Entity("video_histories")
@Index("IDX_video_histories_user_id_created_at", ["userId", "createdAt"])
@Index("UQ_video_histories_operation_name", ["operationName"], {
  unique: true,
  where: `"operation_name" IS NOT NULL`,
})
export class VideoHistory extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "text" })
  prompt!: string;

  @Column({ name: "display_name", type: "varchar", length: 255 })
  displayName!: string;

  @Column({ type: "varchar", length: 128 })
  model!: string;

  @Column({ name: "aspect_ratio", type: "varchar", length: 16 })
  aspectRatio!: string;

  @Column({ name: "duration_seconds", type: "int" })
  durationSeconds!: number;

  @Column({ type: "varchar", length: 16 })
  resolution!: string;

  @Column({ name: "person_generation", type: "varchar", length: 32, nullable: true })
  personGeneration!: string | null;

  @Column({ type: "bigint", nullable: true })
  seed!: string | null;

  @Column({ name: "api_key_tier", type: "varchar", length: 16 })
  apiKeyTier!: string;

  @Column({ name: "operation_name", type: "varchar", length: 512, nullable: true })
  operationName!: string | null;

  @Column({
    type: "enum",
    enum: QueueJobStatus,
    enumName: "video_histories_status_enum",
    default: QueueJobStatus.PENDING,
  })
  status!: QueueJobStatus;

  @Column({ name: "gemini_video_uri", type: "text", nullable: true })
  geminiVideoUri!: string | null;

  @Column({ name: "result_mime_type", type: "varchar", length: 128, nullable: true })
  resultMimeType!: string | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;
}
