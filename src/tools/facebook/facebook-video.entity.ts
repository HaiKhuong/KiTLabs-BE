import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";
import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { FacebookPage } from "./facebook-page.entity";
import { FacebookPlaylist } from "./facebook-playlist.entity";
import { FacebookVideoCommentAttempt } from "./facebook.types";

@Entity("facebook_videos")
@Index(["pageId", "facebookVideoId"], { unique: true })
@Index(["pageId", "playlistId"])
export class FacebookVideo extends BaseEntity {
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

  @Column({ name: "facebook_video_id", type: "varchar", length: 128 })
  facebookVideoId!: string;

  @Column({ name: "playlist_id", type: "uuid", nullable: true })
  playlistId!: string | null;

  @ManyToOne(() => FacebookPlaylist, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "playlist_id" })
  playlist!: FacebookPlaylist | null;

  @Column({ name: "playlist_title", type: "varchar", length: 500, nullable: true })
  playlistTitle!: string | null;

  @Column({ type: "varchar", length: 1000 })
  title!: string;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  @Column({ type: "varchar", length: 2000 })
  permalink!: string;

  @Column({ name: "picture_url", type: "text", nullable: true })
  pictureUrl!: string | null;

  @Column({ type: "numeric", precision: 10, scale: 2, nullable: true })
  length!: string | null;

  @Column({ name: "published_at", type: "timestamptz", nullable: true })
  publishedAt!: Date | null;

  @Column({ name: "season_label", type: "varchar", length: 100, nullable: true })
  seasonLabel!: string | null;

  @Column({ name: "comment_results", type: "jsonb", default: () => "'[]'" })
  commentResults!: FacebookVideoCommentAttempt[];
}

