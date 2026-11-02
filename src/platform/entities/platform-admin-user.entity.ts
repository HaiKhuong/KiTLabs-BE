import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { PlatformAdminRole } from "./platform-admin-role.entity";

@Entity("platform_admin_users")
export class PlatformAdminUser {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at", nullable: true })
  deletedAt!: Date | null;

  @Index({ unique: true })
  @Column({ name: "user_name", type: "varchar", length: 100 })
  userName!: string;

  @Index({ unique: true })
  @Column({ type: "varchar", length: 150 })
  email!: string;

  @Column({ name: "password_hash", type: "varchar", length: 255 })
  passwordHash!: string;

  @Column({ name: "full_name", type: "varchar", length: 150, nullable: true })
  fullName!: string | null;

  @Column({ type: "varchar", length: 30, nullable: true })
  phone!: string | null;

  @Column({ name: "avatar_url", type: "varchar", length: 255, nullable: true })
  avatarUrl!: string | null;

  @Column({ name: "role_id", type: "uuid", nullable: true })
  roleId!: string | null;

  @ManyToOne(() => PlatformAdminRole, (r) => r.users, { onDelete: "SET NULL", nullable: true })
  @JoinColumn({ name: "role_id" })
  role?: PlatformAdminRole | null;

  @Column({ name: "is_super_admin", type: "boolean", default: false })
  isSuperAdmin!: boolean;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @Column({ name: "last_login_at", type: "timestamptz", nullable: true })
  lastLoginAt!: Date | null;

  @Column({ name: "refresh_token_hash", type: "varchar", length: 255, nullable: true })
  refreshTokenHash!: string | null;
}

