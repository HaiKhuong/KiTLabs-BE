import { Column, Entity, JoinColumn, ManyToOne } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { SourceType } from "../../common/enums/domain.enums";
import { User } from "../users/user.entity";

@Entity("download_histories")
export class DownloadHistory extends BaseEntity {
  @Column({ name: "user_id" })
  userId!: string;

  @ManyToOne(() => User, (user) => user.downloadHistories, { onDelete: "CASCADE" })
  @JoinColumn({ name: "user_id" })
  user!: User;

  @Column({ type: "enum", enum: SourceType, name: "source_type" })
  sourceType!: SourceType;

  @Column({ type: "text", name: "source_value" })
  sourceValue!: string;

  @Column({ type: "varchar", name: "saved_path", nullable: true })
  savedPath!: string | null;

  @Column({ type: "varchar", length: 30, default: "queued" })
  status!: string;

  @Column({ type: "text", nullable: true })
  message!: string | null;
}
