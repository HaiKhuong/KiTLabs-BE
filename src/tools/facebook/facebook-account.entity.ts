import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { FacebookAccountStatus } from "./facebook.types";
import { FacebookPage } from "./facebook-page.entity";

@Entity("facebook_accounts")
@Index(["userId"], { unique: true })
export class FacebookAccount extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ name: "fb_user_id", type: "varchar", length: 64 })
  fbUserId!: string;

  @Column({ type: "varchar", length: 200, nullable: true })
  name!: string | null;

  @Column({ name: "picture_url", type: "text", nullable: true })
  pictureUrl!: string | null;

  @Column({ name: "access_token_encrypted", type: "text", nullable: true })
  accessTokenEncrypted!: string | null;

  @Column({ name: "token_expires_at", type: "timestamptz", nullable: true })
  tokenExpiresAt!: Date | null;

  @Column({ type: "text", array: true, default: "{}" })
  scopes!: string[];

  @Column({ type: "varchar", length: 32, default: FacebookAccountStatus.CONNECTED })
  status!: FacebookAccountStatus;

  @Column({ name: "last_checked_at", type: "timestamptz", nullable: true })
  lastCheckedAt!: Date | null;

  @Column({ name: "last_check_message", type: "text", nullable: true })
  lastCheckMessage!: string | null;

  @OneToMany(() => FacebookPage, (page) => page.account)
  pages!: FacebookPage[];
}
