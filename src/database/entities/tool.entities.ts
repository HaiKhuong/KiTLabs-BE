import { CreditHistory } from "../../tools/credits/credit-history.entity";
import { DownloadHistory } from "../../tools/downloads/download-history.entity";
import { VideoDownload } from "../../tools/downloads/video-download.entity";
import { UserActionLog } from "../../tools/logs/user-action-log.entity";
import { Notification } from "../../tools/notifications/notification.entity";
import { Setting } from "../../tools/settings/setting.entity";
import { UserSettingProfile } from "../../tools/settings/user-setting-profile.entity";
import { UserSetting } from "../../tools/settings/user-setting.entity";
import { TranslateHistory } from "../../tools/translate/translate-history.entity";
import { User } from "../../tools/users/user.entity";

export const TOOL_DB_ENTITIES = [
  User,
  CreditHistory,
  UserActionLog,
  TranslateHistory,
  DownloadHistory,
  VideoDownload,
  Notification,
  Setting,
  UserSettingProfile,
  UserSetting,
];
