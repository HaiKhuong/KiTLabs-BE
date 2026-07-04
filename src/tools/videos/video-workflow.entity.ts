import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";

@Entity("video_workflows")
@Index("IDX_video_workflows_user_id_name", ["userId", "name"], { unique: true })
export class VideoWorkflow extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "varchar", length: 255, default: "default" })
  name!: string;

  /** Full canvas document (nodes + edges + layout). */
  @Column({ type: "jsonb" })
  document!: Record<string, unknown>;

  /** Compact node list: name + params. */
  @Column({ name: "nodes_export", type: "jsonb" })
  nodesExport!: Record<string, unknown>;

  /** Hash of document for cheap change detection. */
  @Column({ name: "content_hash", type: "varchar", length: 64 })
  contentHash!: string;
}
