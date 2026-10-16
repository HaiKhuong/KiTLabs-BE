import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { FacebookTaskKind, FacebookTaskOutcome } from "./facebook.types";
import { FacebookPost } from "./facebook-post.entity";

@Entity("facebook_task_logs")
@Index(["userId", "createdAt"])
export class FacebookTaskLog extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "post_id", type: "uuid", nullable: true })
  postId!: string | null;

  @ManyToOne(() => FacebookPost, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "post_id" })
  post!: FacebookPost | null;

  @Column({ name: "page_id", type: "uuid", nullable: true })
  pageId!: string | null;

  @Column({ type: "varchar", length: 32 })
  kind!: FacebookTaskKind;

  @Column({ type: "int", default: 1 })
  attempt!: number;

  @Column({ name: "started_at", type: "timestamptz" })
  startedAt!: Date;

  @Column({ name: "finished_at", type: "timestamptz", nullable: true })
  finishedAt!: Date | null;

  @Column({ name: "facebook_object_id", type: "varchar", length: 128, nullable: true })
  facebookObjectId!: string | null;

  @Column({ name: "phase_before", type: "varchar", length: 16, nullable: true })
  phaseBefore!: string | null;

  @Column({ name: "error_code", type: "varchar", length: 100, nullable: true })
  errorCode!: string | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;

  @Column({ name: "http_status", type: "int", nullable: true })
  httpStatus!: number | null;

  @Column({ default: false })
  retryable!: boolean;

  @Column({ type: "varchar", length: 32 })
  outcome!: FacebookTaskOutcome;
}
