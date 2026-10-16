import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { CommentTemplate, FacebookSelectionRule } from "./facebook.types";

@Entity("facebook_comment_settings")
@Index(["userId"], { unique: true })
export class FacebookCommentSettings extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "auto_comment_video", default: false })
  autoCommentVideo!: boolean;

  @Column({ name: "auto_comment_post", default: false })
  autoCommentPost!: boolean;

  @Column({ name: "comment_count", type: "int", default: 1 })
  commentCount!: number;

  @Column({ name: "selection_rule", type: "varchar", length: 16, default: FacebookSelectionRule.RANDOM })
  selectionRule!: FacebookSelectionRule;

  @Column({ name: "sequential_cursor", type: "int", default: 0 })
  sequentialCursor!: number;

  @Column({ type: "jsonb", default: () => "'[]'" })
  templates!: CommentTemplate[];
}
