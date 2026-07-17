import { CreditHistory } from "../../tools/credits/credit-history.entity";
import { DownloadHistory } from "../../tools/downloads/download-history.entity";
import { VideoDownload } from "../../tools/downloads/video-download.entity";
import { UserActionLog } from "../../tools/logs/user-action-log.entity";
import { Notification } from "../../tools/notifications/notification.entity";
import { Setting } from "../../tools/settings/setting.entity";
import { UserSettingProfile } from "../../tools/settings/user-setting-profile.entity";
import { UserSetting } from "../../tools/settings/user-setting.entity";
import { AudioCloneVoice } from "../../tools/audio/audio-clone-voice.entity";
import { AudioHistory } from "../../tools/audio/audio-history.entity";
import { ImageHistory } from "../../tools/images/image-history.entity";
import { RecapHistory } from "../../tools/recap/recap-history.entity";
import { ShortVideoHistory } from "../../tools/shortvideo/shortvideo-history.entity";
import { TranslateHistory } from "../../tools/translate/translate-history.entity";
import { User } from "../../tools/users/user.entity";
import { ChunkUpload } from "../../tools/files/entities/chunk-upload.entity";
import { WorkflowEntity } from "../../tools/workflow/workflow.entity";
import {
  YouTubeChannel,
  YouTubeVideo,
  Movie,
  MovieTrend,
  AnalyticsSnapshot,
  Recommendation,
} from "../../tools/youtube/entities";
import { AiChatHistory } from "../../tools/youtube/entities/ai-chat-history.entity";

export const TOOL_DB_ENTITIES = [
  User,
  CreditHistory,
  UserActionLog,
  AudioHistory,
  ImageHistory,
  AudioCloneVoice,
  TranslateHistory,
  RecapHistory,
  ShortVideoHistory,
  DownloadHistory,
  VideoDownload,
  Notification,
  Setting,
  UserSettingProfile,
  UserSetting,
  YouTubeChannel,
  YouTubeVideo,
  Movie,
  MovieTrend,
  AnalyticsSnapshot,
  Recommendation,
  AiChatHistory,
  ChunkUpload,
  WorkflowEntity,
];
