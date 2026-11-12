import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";
import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { FacebookPage } from "./facebook-page.entity";
import {
  CommentTemplate,
  CrossPromoTemplate,
  FacebookSelectionRule,
  MoviePlaylistTemplate,
} from "./facebook.types";

@Entity("facebook_page_comment_settings")
@Index(["userId", "pageId"], { unique: true })
export class FacebookPageCommentSettings extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "page_id", type: "uuid" })
  pageId!: string;

  @ManyToOne(() => FacebookPage, { onDelete: "CASCADE" })
  @JoinColumn({ name: "page_id" })
  page!: FacebookPage;

  @Column({ name: "selection_rule", type: "varchar", length: 16, default: FacebookSelectionRule.RANDOM })
  selectionRule!: FacebookSelectionRule;

  @Column({ name: "sequential_cursor", type: "int", default: 0 })
  sequentialCursor!: number;

  @Column({ name: "affiliate_templates", type: "jsonb", default: () => "'[]'" })
  affiliateTemplates!: CommentTemplate[];

  @Column({ name: "movie_playlist_templates", type: "jsonb", default: () => "'[]'" })
  moviePlaylistTemplates!: MoviePlaylistTemplate[];

  @Column({ name: "cross_promo_templates", type: "jsonb", default: () => "'[]'" })
  crossPromoTemplates!: CrossPromoTemplate[];
}

