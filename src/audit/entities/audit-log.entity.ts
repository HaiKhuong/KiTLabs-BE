import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity("audit_logs")
export class AuditLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ type: "varchar", length: 64 })
  module!: string; // 'film' | 'admin' | 'tools_web' | 'tools_app'

  @Index()
  @Column({ name: "session_id", type: "varchar", length: 128 })
  sessionId!: string;

  @Index()
  @Column({ type: "varchar", length: 64 })
  event!: string; // 'load_page' | 'search' | 'play_movie' | 'comment' | 'change_avt' | 'change_name' | 'share' | 'report' | 'favorites'

  @Column({ name: "object_id", type: "varchar", length: 255, nullable: true })
  objectId!: string | null;

  @Column({ name: "object_name", type: "text", nullable: true })
  objectName!: string | null;

  @Column({ name: "object_type", type: "varchar", length: 64, nullable: true })
  objectType!: string | null;

  @Column({ name: "error_code", type: "varchar", length: 64, nullable: true })
  errorCode!: string | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;

  @Column({ type: "varchar", length: 255, nullable: true })
  page!: string | null;

  @Column({ name: "user_id", type: "varchar", length: 64, nullable: true })
  userId!: string | null;

  @Column({ name: "device_id", type: "varchar", length: 128, nullable: true })
  deviceId!: string | null;

  @Column({ type: "jsonb", nullable: true })
  metadata!: Record<string, any> | null;

  @Column({ name: "ip_address", type: "varchar", length: 64, nullable: true })
  ipAddress!: string | null;

  @Column({ name: "user_agent", type: "text", nullable: true })
  userAgent!: string | null;

  @Index()
  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}

