import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";

@Entity("audio_clone_voices")
@Index("IDX_audio_clone_voices_file_name", ["fileName"], { unique: true })
@Index("IDX_audio_clone_voices_user_id_created_at", ["userId", "createdAt"])
export class AudioCloneVoice extends BaseEntity {
  @Column({ name: "user_id", type: "uuid", nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "user_id" })
  user!: User | null;

  /** Tên hiển thị do user nhập. */
  @Column({ name: "display_name", type: "varchar", length: 255 })
  displayName!: string;

  /** Tên file trên disk (unique), dùng cho pipelineRefWav. */
  @Column({ name: "file_name", type: "varchar", length: 255 })
  fileName!: string;

  @Column({ name: "ref_text", type: "text" })
  refText!: string;

  @Column({ name: "file_path", type: "varchar", length: 1024 })
  filePath!: string;

  @Column({ name: "file_size", type: "int", default: 0 })
  fileSize!: number;

  @Column({ name: "mime_type", type: "varchar", length: 64, nullable: true })
  mimeType!: string | null;
}
