import { Column, Entity, Index, OneToMany } from "typeorm";
import { BaseEntity } from "../../common/entities/base.entity";
import { PlatformFacebookPage } from "./platform-facebook-page.entity";

export enum PlatformAccountStatus {
  CONNECTED = "connected",
  EXPIRED = "expired",
  REVOKED = "revoked",
  MISSING_PERMISSION = "missing_permission",
}

@Entity("platform_accounts")
@Index(["userId", "provider", "accountId"], { unique: true })
@Index(["userId", "provider"])
export class PlatformAccount extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @Column({ type: "varchar", length: 32 })
  provider!: string; // 'facebook', 'tiktok'

  @Column({ name: "account_id", type: "varchar", length: 128 })
  accountId!: string; // fbUserId or openId

  @Column({ name: "union_id", type: "varchar", length: 128, nullable: true })
  unionId!: string | null;

  @Column({ type: "varchar", length: 150, nullable: true })
  username!: string | null;

  @Column({ name: "display_name", type: "varchar", length: 200, nullable: true })
  displayName!: string | null;

  @Column({ name: "avatar_url", type: "text", nullable: true })
  avatarUrl!: string | null;

  @Column({ name: "access_token_encrypted", type: "text", nullable: true })
  accessTokenEncrypted!: string | null;

  @Column({ name: "refresh_token_encrypted", type: "text", nullable: true })
  refreshTokenEncrypted!: string | null;

  @Column({ name: "token_expires_at", type: "timestamptz", nullable: true })
  tokenExpiresAt!: Date | null;

  @Column({ name: "refresh_expires_at", type: "timestamptz", nullable: true })
  refreshExpiresAt!: Date | null;

  @Column({ type: "text", array: true, default: "{}" })
  scopes!: string[];

  @Column({ type: "varchar", length: 32, default: PlatformAccountStatus.CONNECTED })
  status!: PlatformAccountStatus;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @Column({ type: "jsonb", nullable: true })
  metadata!: Record<string, any> | null;

  @Column({ name: "last_checked_at", type: "timestamptz", nullable: true })
  lastCheckedAt!: Date | null;

  @Column({ name: "last_check_message", type: "text", nullable: true })
  lastCheckMessage!: string | null;

  @OneToMany(() => PlatformFacebookPage, (page) => page.account)
  facebookPages!: PlatformFacebookPage[];
}

