import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { FacebookPageStatus } from "./facebook.types";
import { FacebookAccount } from "./facebook-account.entity";

@Entity("facebook_pages")
@Index(["accountId", "pageId"], { unique: true })
export class FacebookPage extends BaseEntity {
  @Column({ name: "account_id", type: "uuid" })
  accountId!: string;

  @ManyToOne(() => FacebookAccount, (account) => account.pages, { onDelete: "CASCADE" })
  @JoinColumn({ name: "account_id" })
  account!: FacebookAccount;

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

  @Column({ name: "can_publish", default: false })
  canPublish!: boolean;

  @Column({ name: "can_comment", default: false })
  canComment!: boolean;

  @Column({ type: "varchar", length: 32, default: FacebookPageStatus.ACTIVE })
  status!: FacebookPageStatus;

  @Column({ name: "last_checked_at", type: "timestamptz", nullable: true })
  lastCheckedAt!: Date | null;
}
