import { Column, Entity, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { QueueJobStatus } from "../../common/enums/domain.enums";
import { User } from "../users/user.entity";

@Entity("short_video_histories")
export class ShortVideoHistory extends BaseEntity {
  @Column({ name: "user_id" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  /** FE workflow node id (for socket correlation). */
  @Column({ name: "node_id", type: "varchar", length: 255, nullable: true })
  nodeId!: string | null;

  @Column({ name: "display_name", type: "varchar", length: 255 })
  displayName!: string;

  /** ShortVideo JSON spec (background, left/right, voice, scenes). */
  @Column({ name: "spec", type: "jsonb", nullable: true })
  spec!: Record<string, unknown> | null;

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
}
