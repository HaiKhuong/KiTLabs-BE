import { Column, DeleteDateColumn, Entity } from "typeorm";
import { BaseEntity } from "../../common/entities/base.entity";

@Entity("desktop_devices")
export class PlatformDesktopDevice extends BaseEntity {
  @DeleteDateColumn({ name: "deleted_at", type: "timestamp with time zone", nullable: true })
  deletedAt!: Date | null;
  @Column({ name: "device_id", type: "varchar", length: 128, unique: true })
  deviceId!: string;

  @Column({ type: "varchar", length: 150, default: "" })
  label!: string;

  @Column({ type: "varchar", length: 150, nullable: true })
  hostname!: string | null;

  @Column({ name: "is_configured", type: "boolean", default: true })
  isConfigured!: boolean;

  @Column({ type: "text", nullable: true })
  note!: string | null;

  @Column({ name: "is_active", type: "boolean", default: true })
  isActive!: boolean;

  @Column({ name: "allowed_menus", type: "jsonb", default: () => "'[]'" })
  allowedMenus!: string[];

  @Column({ name: "app_version", type: "varchar", length: 64, nullable: true })
  appVersion!: string | null;

  @Column({ name: "last_ip", type: "varchar", length: 64, nullable: true })
  lastIp!: string | null;

  @Column({ name: "last_seen_at", type: "timestamp", nullable: true })
  lastSeenAt!: Date | null;
}
