import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";
import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { FacebookPage } from "./facebook-page.entity";

@Entity("facebook_playlists")
@Index(["pageId", "facebookPlaylistId"], { unique: true })
export class FacebookPlaylist extends BaseEntity {
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

  @Column({ name: "facebook_playlist_id", type: "varchar", length: 128 })
  facebookPlaylistId!: string;

  @Column({ type: "varchar", length: 500 })
  title!: string;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  @Column({ name: "video_count", type: "int", default: 0 })
  videoCount!: number;

  @Column({ name: "synced_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  syncedAt!: Date;
}

