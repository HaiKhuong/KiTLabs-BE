import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { TikTokAccountStatus } from "./tiktok.types";
import { TikTokVideo } from "./tiktok-video.entity";

@Entity("tiktok_accounts")
@Index(["userId", "openId"], { unique: true })
export class TikTokAccount extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "open_id", type: "varchar", length: 128 })
  openId!: string;

  @Column({ name: "union_id", type: "varchar", length: 128, nullable: true })
  unionId!: string | null;

  @Column({ type: "varchar", length: 150, nullable: true })
  username!: string | null;

  @Column({ name: "display_name", type: "varchar", length: 150, nullable: true })
  displayName!: string | null;

  @Column({ name: "avatar_url", type: "text", nullable: true })
  avatarUrl!: string | null;

  @Column({ name: "access_token_encrypted", type: "text" })
  accessTokenEncrypted!: string;

  @Column({ name: "refresh_token_encrypted", type: "text" })
  refreshTokenEncrypted!: string;

  @Column({ name: "access_token_expires_at", type: "timestamptz" })
  accessTokenExpiresAt!: Date;

  @Column({ name: "refresh_token_expires_at", type: "timestamptz" })
  refreshTokenExpiresAt!: Date;

  @Column({ type: "text", array: true, default: "{}" })
  scopes!: string[];

  @Column({ type: "enum", enum: TikTokAccountStatus, default: TikTokAccountStatus.CONNECTED })
  status!: TikTokAccountStatus;

  @Column({ name: "is_active", default: false })
  isActive!: boolean;

  @OneToMany(() => TikTokVideo, (video) => video.account)
  videos!: TikTokVideo[];
}
