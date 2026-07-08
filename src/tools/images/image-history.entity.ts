import { Column, Entity, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { QueueJobStatus } from "../../common/enums/domain.enums";
import { User } from "../users/user.entity";

@Entity("image_histories")
export class ImageHistory extends BaseEntity {
  @Column({ name: "user_id" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "text" })
  prompt!: string;

  @Column({ name: "display_name", type: "varchar", length: 255 })
  displayName!: string;

  @Column({ name: "negative_prompt", type: "text", nullable: true })
  negativePrompt!: string | null;

  @Column({ type: "varchar", length: 64 })
  style!: string;

  @Column({ name: "aspect_ratio", type: "varchar", length: 16 })
  aspectRatio!: string;

  @Column({ type: "varchar", length: 128 })
  model!: string;

  @Column({ name: "num_inference_steps", type: "int", nullable: true })
  numInferenceSteps!: number | null;

  @Column({ type: "int", nullable: true })
  seed!: number | null;

  @Column({ type: "enum", enum: QueueJobStatus, default: QueueJobStatus.PENDING })
  status!: QueueJobStatus;

  @Column({ type: "varchar", name: "result_path", nullable: true })
  resultPath!: string | null;

  @Column({ type: "varchar", name: "result_file_name", nullable: true })
  resultFileName!: string | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;

  @Column({ name: "enriched_prompt", type: "text", nullable: true })
  enrichedPrompt!: string | null;

  @Column({ name: "gemini_analysis", type: "jsonb", nullable: true })
  geminiAnalysis!: Record<string, unknown> | null;
}
