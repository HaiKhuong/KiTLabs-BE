import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { FacebookPage } from "./facebook-page.entity";
import {
  FacebookCommentAttempt,
  FacebookContentKind,
  FacebookPostStatus,
  FacebookUploadPhase,
} from "./facebook.types";

@Entity("facebook_posts")
@Index(["userId", "createdAt"])
@Index(["status", "scheduledAt"])
export class FacebookPost extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "page_id", type: "uuid", nullable: true })
  pageId!: string | null;

  @ManyToOne(() => FacebookPage, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "page_id" })
  page!: FacebookPage | null;

  @Column({ type: "varchar", length: 16 })
  kind!: FacebookContentKind;

  @Column({ type: "varchar", length: 255, nullable: true })
  title!: string | null;

  @Column({ type: "text", nullable: true })
  message!: string | null;

  @Column({ name: "local_path", type: "text", nullable: true })
  localPath!: string | null;

  @Column({ name: "original_file_name", type: "varchar", length: 255, nullable: true })
  originalFileName!: string | null;

  @Column({ name: "file_size", type: "bigint", nullable: true })
  fileSize!: string | null;

  @Column({ type: "varchar", length: 32, default: FacebookPostStatus.DRAFT })
  status!: FacebookPostStatus;

  @Column({ name: "scheduled_at", type: "timestamptz", nullable: true })
  scheduledAt!: Date | null;

  @Column({ name: "published_at", type: "timestamptz", nullable: true })
  publishedAt!: Date | null;

  @Column({ name: "facebook_post_id", type: "varchar", length: 128, nullable: true })
  facebookPostId!: string | null;

  @Column({ name: "upload_phase", type: "varchar", length: 16, default: FacebookUploadPhase.NONE })
  uploadPhase!: FacebookUploadPhase;

  @Column({ name: "upload_session_id", type: "varchar", length: 255, nullable: true })
  uploadSessionId!: string | null;

  @Column({ name: "upload_offset", type: "bigint", default: "0" })
  uploadOffset!: string;

  @Column({ name: "affiliate_enabled", default: true })
  affiliateEnabled!: boolean;

  @Column({ name: "source_post_id", type: "uuid", nullable: true })
  sourcePostId!: string | null;

  @Column({ name: "comment_results", type: "jsonb", default: () => "'[]'" })
  commentResults!: FacebookCommentAttempt[];

  @Column({ name: "queue_job_id", type: "varchar", length: 255, nullable: true })
  queueJobId!: string | null;

  @Column({ name: "error_code", type: "varchar", length: 100, nullable: true })
  errorCode!: string | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;
}
