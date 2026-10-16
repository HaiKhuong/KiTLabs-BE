import { Column, Entity, Index, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { User } from "../users/user.entity";
import { FacebookAffiliateStatus } from "./facebook.types";

@Entity("facebook_affiliate_links")
@Index(["userId"])
export class FacebookAffiliateLink extends BaseEntity {
  @Column({ name: "user_id", type: "uuid" })
  userId!: string;

  @ManyToOne(() => User, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "varchar", length: 200 })
  name!: string;

  @Column({ name: "affiliate_url", type: "text" })
  affiliateUrl!: string;

  @Column({ name: "destination_url", type: "text", nullable: true })
  destinationUrl!: string | null;

  @Column({ name: "product_group", type: "varchar", length: 120, default: "" })
  productGroup!: string;

  @Column({ type: "text", array: true, default: "{}" })
  keywords!: string[];

  @Column({ name: "page_ids", type: "text", array: true, default: "{}" })
  pageIds!: string[];

  @Column({ type: "varchar", length: 16, default: FacebookAffiliateStatus.ACTIVE })
  status!: FacebookAffiliateStatus;

  @Column({ name: "starts_at", type: "timestamptz", nullable: true })
  startsAt!: Date | null;

  @Column({ name: "ends_at", type: "timestamptz", nullable: true })
  endsAt!: Date | null;
}
