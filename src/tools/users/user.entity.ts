import { Column, Entity, OneToMany } from "typeorm";

import { BaseEntity } from "../../common/entities/base.entity";
import { CreditHistory } from "../credits/credit-history.entity";
import { DownloadHistory } from "../downloads/download-history.entity";
import { VideoDownload } from "../downloads/video-download.entity";
import { UserActionLog } from "../logs/user-action-log.entity";
import { Notification } from "../notifications/notification.entity";
import { TranslateHistory } from "../translate/translate-history.entity";
import { UserSettingProfile } from "../settings/user-setting-profile.entity";
import { UserSetting } from "../settings/user-setting.entity";

export enum UserAuthType {
  ACCOUNT = "account",
  GUEST = "guest",
}

@Entity("users")
export class User extends BaseEntity {
  @Column({ name: "auth_type", type: "enum", enum: UserAuthType, default: UserAuthType.ACCOUNT })
  authType!: UserAuthType;

  @Column({ type: "varchar", name: "user_name", unique: true, length: 100, nullable: true })
  userName!: string | null;

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

  @OneToMany(() => CreditHistory, (history) => history.user)
  creditHistories!: CreditHistory[];

  @OneToMany(() => UserActionLog, (log) => log.user)
  actionLogs!: UserActionLog[];

  @OneToMany(() => TranslateHistory, (history) => history.user)
  translateHistories!: TranslateHistory[];

  @OneToMany(() => DownloadHistory, (history) => history.user)
  downloadHistories!: DownloadHistory[];

  @OneToMany(() => VideoDownload, (video) => video.user)
  videoDownloads!: VideoDownload[];

  @OneToMany(() => Notification, (notification) => notification.user)
  notifications!: Notification[];

  @OneToMany(() => UserSetting, (setting) => setting.user)
  userSettings!: UserSetting[];

  @OneToMany(() => UserSettingProfile, (profile) => profile.user)
  userSettingProfiles!: UserSettingProfile[];
}
