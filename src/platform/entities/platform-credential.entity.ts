import { Column, Entity, Index } from "typeorm";
import { BaseEntity } from "../../common/entities/base.entity";

@Entity("platform_credentials")
@Index(["provider", "code"], { unique: true })
export class PlatformCredential extends BaseEntity {
  @Column({ type: "varchar", length: 32 })
  provider!: string; // 'facebook', 'tiktok', etc.

  @Column({ type: "varchar", length: 64 })
  code!: string; // 'META_APP_ID', 'META_APP_SECRET', 'TIKTOK_CLIENT_KEY', etc.

  @Column({ type: "text" })
  value!: string;

  @Column({ name: "is_secret", type: "boolean", default: false })
  isSecret!: boolean;

  @Column({ type: "varchar", length: 255, nullable: true })
  description!: string | null;
}

