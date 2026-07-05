import { Column, Entity, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { QueueJobStatus } from "../../common/enums/domain.enums";
import { User } from "../users/user.entity";

export type AudioVoiceMode = "preset" | "clone";

@Entity("audio_histories")
export class AudioHistory extends BaseEntity {
  @Column({ name: "user_id" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "input_text", type: "text" })
  inputText!: string;

  @Column({ name: "display_name", type: "varchar", length: 255 })
  displayName!: string;

  @Column({ name: "voice_mode", type: "varchar", length: 16 })
  voiceMode!: AudioVoiceMode;

  @Column({ name: "voice_id", type: "varchar", length: 64, nullable: true })
  voiceId!: string | null;

  @Column({ name: "engine_config", type: "jsonb", nullable: true })
  engineConfig!: Record<string, unknown> | null;

  @Column({ type: "enum", enum: QueueJobStatus, default: QueueJobStatus.PENDING })
  status!: QueueJobStatus;

  @Column({ type: "numeric", precision: 12, scale: 2, default: 0 })
  cost!: string;

  @Column({ type: "varchar", name: "result_path", nullable: true })
  resultPath!: string | null;

  @Column({ type: "varchar", name: "result_file_name", nullable: true })
  resultFileName!: string | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;

  @Column({ type: "varchar", name: "queue_job_id", nullable: true })
  queueJobId!: string | null;
}
