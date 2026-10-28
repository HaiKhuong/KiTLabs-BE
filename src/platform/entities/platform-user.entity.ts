import { Column, Entity } from "typeorm";
import { BaseEntity } from "../../common/entities/base.entity";

export enum PlatformUserAuthType {
  ACCOUNT = "account",
  GUEST = "guest",
}

export enum PlatformUserRole {
  ADMIN = "ADMIN",
  USER = "USER",
}

@Entity("users")
export class PlatformUser extends BaseEntity {
  @Column({ name: "auth_type", type: "varchar", default: PlatformUserAuthType.ACCOUNT })
  authType!: string;

  @Column({ type: "varchar", name: "user_name", unique: true, length: 100, nullable: true })
  userName!: string | null;

  @Column({ type: "varchar", unique: true, length: 150, nullable: true })
  email!: string | null;

  @Column({ type: "varchar", length: 32, default: PlatformUserRole.USER })
  role!: string;

  @Column({ type: "varchar", name: "password_hash", length: 255, nullable: true })
  passwordHash!: string | null;

  @Column({ type: "varchar", name: "refresh_token_hash", length: 255, nullable: true })
  refreshTokenHash!: string | null;

  @Column({ type: "numeric", precision: 12, scale: 2, default: 0 })
  credit!: string;

  @Column({ type: "varchar", name: "device_id", length: 255, nullable: true })
  deviceId!: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  ip!: string | null;

  @Column({ type: "varchar", length: 64, nullable: true })
  mac!: string | null;

  @Column({ name: "is_active", default: true })
  isActive!: boolean;
}
