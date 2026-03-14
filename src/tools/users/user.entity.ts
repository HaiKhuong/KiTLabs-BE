import { Column, Entity, OneToMany } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { CreditHistory } from "../credits/credit-history.entity";
import { DownloadHistory } from "../downloads/download-history.entity";
import { UserActionLog } from "../logs/user-action-log.entity";
import { Notification } from "../notifications/notification.entity";
import { TranslateHistory } from "../translate/translate-history.entity";
import { UserSetting } from "../settings/user-setting.entity";

@Entity("users")
export class User extends BaseEntity {
  @Column({ name: "user_name", unique: true, length: 100 })
  userName!: string;

  @Column({ name: "password_hash", length: 255 })
  passwordHash!: string;

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

  @OneToMany(() => CreditHistory, (history) => history.user)
  creditHistories!: CreditHistory[];

  @OneToMany(() => UserActionLog, (log) => log.user)
  actionLogs!: UserActionLog[];

  @OneToMany(() => TranslateHistory, (history) => history.user)
  translateHistories!: TranslateHistory[];

  @OneToMany(() => DownloadHistory, (history) => history.user)
  downloadHistories!: DownloadHistory[];

  @OneToMany(() => Notification, (notification) => notification.user)
  notifications!: Notification[];

  @OneToMany(() => UserSetting, (setting) => setting.user)
  userSettings!: UserSetting[];
}
