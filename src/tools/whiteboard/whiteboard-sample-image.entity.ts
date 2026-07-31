import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";

@Entity("whiteboard_sample_images")
@Index("IDX_whiteboard_sample_images_user_id_created_at", ["userId", "createdAt"])
export class WhiteboardSampleImage extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  /** Stored file name under `_samples/{userId}/` (e.g. `{id}.png`). */
  @Column({ name: "file_name", type: "varchar", length: 255 })
  fileName!: string;

  /** Original upload name for display. */
  @Column({ name: "original_name", type: "varchar", length: 512 })
  originalName!: string;

  @Column({ name: "mime_type", type: "varchar", length: 64, nullable: true })
  mimeType!: string | null;

  @Column({ name: "file_size", type: "int", default: 0 })
  fileSize!: number;
}
