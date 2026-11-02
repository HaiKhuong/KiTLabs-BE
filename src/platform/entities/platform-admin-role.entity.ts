import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { PlatformAdminUser } from "./platform-admin-user.entity";

@Entity("platform_admin_roles")
export class PlatformAdminRole {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;

  @DeleteDateColumn({ name: "deleted_at", nullable: true })
  deletedAt!: Date | null;

  @Index({ unique: true })
  @Column({ type: "varchar", length: 50 })
  code!: string;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  @Column({ name: "is_system", type: "boolean", default: false })
  isSystem!: boolean;

  @Column({ type: "jsonb", default: () => "'{}'" })
  permissions!: Record<string, any>;

  @OneToMany(() => PlatformAdminUser, (u) => u.role)
  users?: PlatformAdminUser[];
}

