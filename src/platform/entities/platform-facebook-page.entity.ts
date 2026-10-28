import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";
import { BaseEntity } from "../../common/entities/base.entity";
import { PlatformAccount } from "./platform-account.entity";

export enum PlatformFacebookPageStatus {
  ACTIVE = "active",
  LOST_ACCESS = "lost_access",
}

@Entity("platform_facebook_pages")
@Index(["accountId", "pageId"], { unique: true })
@Index(["accountId"])
export class PlatformFacebookPage extends BaseEntity {
  @Column({ name: "account_id", type: "uuid" })
  accountId!: string;

  @ManyToOne(() => PlatformAccount, (account) => account.facebookPages, { onDelete: "CASCADE" })
  @JoinColumn({ name: "account_id" })
  account!: PlatformAccount;

  @Column({ name: "page_id", type: "varchar", length: 64 })
  pageId!: string;

  @Column({ type: "varchar", length: 200 })
  name!: string;

  @Column({ name: "picture_url", type: "text", nullable: true })
  pictureUrl!: string | null;

  @Column({ name: "page_access_token_encrypted", type: "text", nullable: true })
  pageAccessTokenEncrypted!: string | null;

  @Column({ type: "text", array: true, default: "{}" })
  tasks!: string[];

  @Column({ name: "can_publish", type: "boolean", default: false })
  canPublish!: boolean;

  @Column({ name: "can_comment", type: "boolean", default: false })
  canComment!: boolean;

  @Column({ type: "varchar", length: 32, default: PlatformFacebookPageStatus.ACTIVE })
  status!: PlatformFacebookPageStatus;

  @Column({ name: "last_checked_at", type: "timestamptz", nullable: true })
  lastCheckedAt!: Date | null;
}

