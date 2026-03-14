import { Column, Entity, PrimaryGeneratedColumn, CreateDateColumn } from "typeorm";

@Entity("spam_logs")
export class SpamLog {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "request_key", length: 128 })
  requestKey!: string;

  @Column({ name: "route_path", length: 255 })
  routePath!: string;

  @Column({ type: "varchar", name: "user_id", nullable: true, length: 64 })
  userId!: string | null;

  @Column({ type: "varchar", name: "ip_address", nullable: true, length: 64 })
  ipAddress!: string | null;

  @Column({ type: "text", nullable: true })
  payload!: string | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;
}
