import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { QueueJobStatus } from "../../common/enums/domain.enums";
import { User } from "../users/user.entity";
import type { ImageEditDomain, ImageEditFeature, ImageEditScale } from "./image-edit.constants";

export type ImageEditFileMeta = {
  name: string;
  label?: string;
  confidence?: number;
};

export type ImageEditDetection = {
  label: string;
  confidence: number;
  box: [number, number, number, number];
};

export type ImageEditOptions = {
  scale?: ImageEditScale;
  domain?: ImageEditDomain;
  files?: ImageEditFileMeta[];
  detections?: ImageEditDetection[];
};

@Entity("image_edit_histories")
@Index("IDX_image_edit_histories_user_feature_created", ["userId", "feature", "createdAt"])
export class ImageEditHistory extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "varchar", length: 32 })
  feature!: ImageEditFeature;

  @Column({ name: "display_name", type: "varchar", length: 255 })
  displayName!: string;

  @Column({ type: "enum", enum: QueueJobStatus, default: QueueJobStatus.PENDING })
  status!: QueueJobStatus;

  @Column({ name: "input_path", type: "text", nullable: true })
  inputPath!: string | null;

  @Column({ name: "input_file_name", type: "varchar", length: 255, nullable: true })
  inputFileName!: string | null;

  @Column({ name: "result_path", type: "text", nullable: true })
  resultPath!: string | null;

  @Column({ name: "result_file_name", type: "varchar", length: 255, nullable: true })
  resultFileName!: string | null;

  @Column({ type: "jsonb", nullable: true })
  options!: ImageEditOptions | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;

  @Column({ type: "varchar", name: "queue_job_id", nullable: true })
  queueJobId!: string | null;
}
