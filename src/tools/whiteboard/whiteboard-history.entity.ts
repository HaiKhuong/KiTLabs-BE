import { Column, Entity, JoinColumn, ManyToOne } from "typeorm";
import { BaseEntity } from "../../common/entities/base.entity";
import { QueueJobStatus } from "../../common/enums/domain.enums";
import { User } from "../users/user.entity";

@Entity("whiteboard_histories")
export class WhiteboardHistory extends BaseEntity {
  @Column({ name: "user_id" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "node_id", type: "varchar", length: 255, nullable: true })
  nodeId!: string | null;

  @Column({ name: "display_name", type: "varchar", length: 255 })
  displayName!: string;

  /** Uploaded source image filename inside work dir. */
  @Column({ name: "source_image_file_name", type: "varchar", length: 512, nullable: true })
  sourceImageFileName!: string | null;

  /** Original image dimensions in pixels. */
  @Column({ name: "image_width", type: "integer", nullable: true })
  imageWidth!: number | null;

  @Column({ name: "image_height", type: "integer", nullable: true })
  imageHeight!: number | null;

  /** Scene JSON returned by Gemini Vision. */
  @Column({ name: "scene_json", type: "jsonb", nullable: true })
  sceneJson!: Record<string, unknown> | null;

  /** Hand path plan computed from sceneJson. */
  @Column({ name: "path_plan", type: "jsonb", nullable: true })
  pathPlan!: Record<string, unknown> | null;

  /** User-supplied render options (fps, duration, brushSize, etc.). */
  @Column({ name: "engine_config", type: "jsonb", nullable: true })
  engineConfig!: Record<string, unknown> | null;

  @Column({ type: "enum", enum: QueueJobStatus, default: QueueJobStatus.PENDING })
  status!: QueueJobStatus;

  @Column({ type: "varchar", name: "result_path", nullable: true })
  resultPath!: string | null;

  @Column({ type: "varchar", name: "result_file_name", nullable: true })
  resultFileName!: string | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;

  @Column({ type: "varchar", name: "queue_job_id", nullable: true })
  queueJobId!: string | null;

  @Column({ type: "timestamp", name: "render_started_at", nullable: true })
  renderStartedAt!: Date | null;

  @Column({ type: "timestamp", name: "render_finished_at", nullable: true })
  renderFinishedAt!: Date | null;

  @Column({ type: "integer", name: "render_duration_ms", nullable: true })
  renderDurationMs!: number | null;
}
