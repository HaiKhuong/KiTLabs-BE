import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";

@Entity("render_logs")
@Index("IDX_render_logs_user_id_created_at", ["userId", "createdAt"])
@Index("IDX_render_logs_feature_created_at", ["feature", "createdAt"])
export class RenderLog extends BaseEntity {
  @Column({ type: "uuid", name: "user_id", nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "user_id" })
  user!: User | null;

  /** Feature that started this render: translate, audio, whiteboard, … */
  @Column({ type: "varchar", length: 64 })
  feature!: string;

  /** Related history row id (may be reused across renders). */
  @Column({ type: "uuid", name: "history_id", nullable: true })
  historyId!: string | null;

  @Column({ type: "varchar", name: "display_name", length: 255, nullable: true })
  displayName!: string | null;

  /** Snapshot of the user configuration used for this render. */
  @Column({ type: "jsonb" })
  data!: Record<string, unknown>;
}
