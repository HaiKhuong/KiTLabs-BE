import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export enum FilmUserRole {
  GUEST = "GUEST",
  USER = "USER",
  VIP = "VIP",
  MODERATOR = "MODERATOR",
  ADMIN = "ADMIN",
}
export enum FilmUserStatus {
  ACTIVE = "ACTIVE",
  BANNED = "BANNED",
  SUSPENDED = "SUSPENDED",
}
export enum SectRank {
  LUYEN_KHI = "LUYEN_KHI",
  TRUC_CO = "TRUC_CO",
  KIM_DAN = "KIM_DAN",
  NGUYEN_ANH = "NGUYEN_ANH",
  HOA_THAN = "HOA_THAN",
  LUAN_HOI = "LUAN_HOI",
  THAN_HOANG = "THAN_HOANG",
}
export enum MovieStatus {
  ONGOING = "ONGOING",
  COMPLETED = "COMPLETED",
  HIATUS = "HIATUS",
}
export enum MovieSchedule {
  MONDAY = "MONDAY",
  TUESDAY = "TUESDAY",
  WEDNESDAY = "WEDNESDAY",
  THURSDAY = "THURSDAY",
  FRIDAY = "FRIDAY",
  SATURDAY = "SATURDAY",
  SUNDAY = "SUNDAY",
  DAILY = "DAILY",
  UNKNOWN = "UNKNOWN",
}
export enum SourceType {
  HLS_M3U8 = "HLS_M3U8",
  MP4 = "MP4",
  EMBED = "EMBED",
  IFRAME = "IFRAME",
}
export enum VideoQuality {
  P360 = "360P",
  P480 = "480P",
  P720 = "720P",
  P1080 = "1080P",
  P4K = "4K",
  AUTO = "AUTO",
}
export enum ItemType {
  AVATAR_FRAME = "AVATAR_FRAME",
  TITLE = "TITLE",
  CHAT_EFFECT = "CHAT_EFFECT",
  STICKER_PACK = "STICKER_PACK",
}
export enum DonationStatus {
  PENDING = "PENDING",
  SUCCESS = "SUCCESS",
  FAILED = "FAILED",
  REFUNDED = "REFUNDED",
}
export enum PaymentMethod {
  MOMO = "MOMO",
  VNPAY = "VNPAY",
  BANK_TRANSFER = "BANK_TRANSFER",
  PAYPAL = "PAYPAL",
  STRIPE = "STRIPE",
}
export enum CommentStatus {
  APPROVED = "APPROVED",
  PENDING_MODERATION = "PENDING_MODERATION",
  HIDDEN = "HIDDEN",
  DELETED = "DELETED",
}
export enum ReactionType {
  LIKE = "LIKE",
  DISLIKE = "DISLIKE",
}
export enum ChatType {
  TEXT = "TEXT",
  EMOJI = "EMOJI",
  STICKER = "STICKER",
  SYSTEM_ANNOUNCEMENT = "SYSTEM_ANNOUNCEMENT",
  DONATE_ALERT = "DONATE_ALERT",
}

abstract class FilmBase {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @CreateDateColumn({ name: "created_at" }) createdAt!: Date;
  @UpdateDateColumn({ name: "updated_at" }) updatedAt!: Date;
  @DeleteDateColumn({ name: "deleted_at", nullable: true }) deletedAt!: Date | null;
}

@Entity("devices")
export class FilmDevice extends FilmBase {
  @Index({ unique: true }) @Column({ name: "device_token", length: 100 }) deviceToken!: string;
  @Column({ name: "first_ip", type: "varchar", length: 64, nullable: true }) firstIp!: string | null;
  @Column({ name: "last_ip", type: "varchar", length: 64, nullable: true }) lastIp!: string | null;
  @Column({ name: "user_agent", type: "text", nullable: true }) userAgent!: string | null;
  @Column({ name: "last_seen_at", type: "timestamptz" }) lastSeenAt!: Date;
}

@Entity("users")
export class FilmUser extends FilmBase {
  @Index({ unique: true }) @Column({ name: "device_id", type: "uuid", nullable: true }) deviceId!: string | null;
  @Index({ unique: true }) @Column({ type: "varchar", length: 100, nullable: true }) username!: string | null;
  @Index({ unique: true }) @Column({ type: "varchar", length: 255, nullable: true }) email!: string | null;
  @Column({ name: "password_hash", type: "varchar", length: 255, nullable: true, select: false }) passwordHash!:
    | string
    | null;
  @Column({ name: "refresh_token_hash", type: "varchar", length: 255, nullable: true, select: false })
  refreshTokenHash!: string | null;
  @Column({ length: 150 }) name!: string;
  @Column({ name: "avatar_url", type: "varchar", nullable: true }) avatarUrl!: string | null;
  @Column({ name: "avatar_frame_id", type: "uuid", nullable: true }) avatarFrameId!: string | null;
  @Column({ type: "enum", enum: FilmUserRole, default: FilmUserRole.GUEST }) role!: FilmUserRole;
  @Column({ type: "enum", enum: FilmUserStatus, default: FilmUserStatus.ACTIVE }) status!: FilmUserStatus;
  @Column({ name: "sect_rank", type: "enum", enum: SectRank, default: SectRank.LUYEN_KHI }) sectRank!: SectRank;
  @Column({ type: "bigint", default: 0 }) exp!: string;
  @Column({ name: "spirit_stones", type: "bigint", default: 0 }) spiritStones!: string;
  @Column({ name: "total_donated_vnd", type: "numeric", precision: 15, scale: 2, default: 0 }) totalDonatedVnd!: string;
  @Column({ name: "total_view_minutes", type: "bigint", default: 0 }) totalViewMinutes!: string;
  @Column({ name: "current_title", type: "varchar", nullable: true }) currentTitle!: string | null;
  @Column({ name: "is_email_verified", default: false }) isEmailVerified!: boolean;
  @Column({ name: "last_login_at", type: "timestamptz", nullable: true }) lastLoginAt!: Date | null;
  @Column({ name: "last_active_at", type: "timestamptz", nullable: true }) lastActiveAt!: Date | null;
}

@Entity("movies")
export class FilmMovie extends FilmBase {
  @Index() @Column() title!: string;
  @Column({ name: "original_title", type: "varchar", nullable: true }) originalTitle!: string | null;
  @Index({ unique: true }) @Column() slug!: string;
  @Column({ type: "text", nullable: true }) description!: string | null;
  @Column({ name: "poster_url" }) posterUrl!: string;
  @Column({ name: "banner_url", type: "varchar", nullable: true }) bannerUrl!: string | null;
  @Column({ type: "enum", enum: MovieStatus, default: MovieStatus.ONGOING }) status!: MovieStatus;
  @Column({ type: "enum", enum: MovieSchedule, default: MovieSchedule.UNKNOWN }) schedule!: MovieSchedule;
  @Column({ type: "varchar", nullable: true }) studio!: string | null;
  @Column({ name: "release_year", type: "int", nullable: true }) releaseYear!: number | null;
  @Column({ name: "total_episodes", type: "int", default: 0 }) totalEpisodes!: number;
  @Column({ name: "current_episode_count", type: "int", default: 0 }) currentEpisodeCount!: number;
  @Index() @Column({ type: "bigint", default: 0 }) views!: string;
  @Column({ name: "rating_avg", type: "numeric", precision: 3, scale: 2, default: 0 }) ratingAvg!: string;
  @Column({ name: "rating_count", default: 0 }) ratingCount!: number;
  @Index() @Column({ name: "rank_score", type: "bigint", default: 0 }) rankScore!: string;
  @Column({ name: "is_hot", default: false }) isHot!: boolean;
  @Column({ name: "is_recommended", default: false }) isRecommended!: boolean;
}

@Entity("genres")
export class FilmGenre extends FilmBase {
  @Index({ unique: true }) @Column() name!: string;
  @Index({ unique: true }) @Column() slug!: string;
  @Column({ type: "varchar", nullable: true }) description!: string | null;
}
@Entity("tags")
export class FilmTag extends FilmBase {
  @Index({ unique: true }) @Column() name!: string;
  @Index({ unique: true }) @Column() code!: string;
}
@Entity("movie_genres")
export class FilmMovieGenre {
  @PrimaryColumn("uuid", { name: "movie_id" }) movieId!: string;
  @PrimaryColumn("uuid", { name: "genre_id" }) genreId!: string;
}
@Entity("movie_tags")
export class FilmMovieTag {
  @PrimaryColumn("uuid", { name: "movie_id" }) movieId!: string;
  @PrimaryColumn("uuid", { name: "tag_id" }) tagId!: string;
}

@Index(["movieId", "episodeNumber"], { unique: true })
@Entity("episodes")
export class FilmEpisode extends FilmBase {
  @Index() @Column("uuid", { name: "movie_id" }) movieId!: string;
  @Column({ name: "episode_number", type: "numeric", precision: 6, scale: 1 }) episodeNumber!: string;
  @Column({ type: "varchar", nullable: true }) title!: string | null;
  @Column({ name: "duration_seconds", default: 0 }) durationSeconds!: number;
  @Column({ type: "bigint", default: 0 }) views!: string;
  @Column({ name: "thumbnail_url", type: "varchar", nullable: true }) thumbnailUrl!: string | null;
}
@Entity("episode_sources")
export class FilmEpisodeSource extends FilmBase {
  @Index() @Column("uuid", { name: "episode_id" }) episodeId!: string;
  @Column({ name: "server_name" }) serverName!: string;
  @Column({ name: "source_type", type: "enum", enum: SourceType }) sourceType!: SourceType;
  @Column({ type: "enum", enum: VideoQuality }) quality!: VideoQuality;
  @Column({ name: "video_url", type: "text" }) videoUrl!: string;
  @Column({ name: "is_active", default: true }) isActive!: boolean;
  @Column({ default: 1 }) priority!: number;
}

@Index(["userId", "episodeId"], { unique: true })
@Entity("watch_histories")
export class FilmWatchHistory extends FilmBase {
  @Index() @Column("uuid", { name: "user_id" }) userId!: string;
  @Column("uuid", { name: "movie_id" }) movieId!: string;
  @Column("uuid", { name: "episode_id" }) episodeId!: string;
  @Column({ name: "stopped_at_seconds", default: 0 }) stoppedAtSeconds!: number;
  @Column({ name: "watched_minutes", default: 0 }) watchedMinutes!: number;
}
@Index(["userId", "movieId"], { unique: true })
@Entity("favorites")
export class FilmFavorite extends FilmBase {
  @Index() @Column("uuid", { name: "user_id" }) userId!: string;
  @Index() @Column("uuid", { name: "movie_id" }) movieId!: string;
}
@Index(["userId", "movieId"], { unique: true })
@Entity("ratings")
export class FilmRating extends FilmBase {
  @Column("uuid", { name: "user_id" }) userId!: string;
  @Column("uuid", { name: "movie_id" }) movieId!: string;
  @Column() score!: number;
  @Column({ type: "text", nullable: true }) review!: string | null;
}

@Entity("comments")
export class FilmComment extends FilmBase {
  @Column("uuid", { name: "user_id" }) userId!: string;
  @Index() @Column("uuid", { name: "movie_id" }) movieId!: string;
  @Index() @Column("uuid", { name: "episode_id", nullable: true }) episodeId!: string | null;
  @Column("uuid", { name: "parent_id", nullable: true }) parentId!: string | null;
  @Column("text") content!: string;
  @Column({ name: "user_sect_rank_snapshot" }) userSectRankSnapshot!: string;
  @Column({ name: "is_spoil", default: false }) isSpoil!: boolean;
  @Column({ name: "likes_count", default: 0 }) likesCount!: number;
  @Column({ name: "dislikes_count", default: 0 }) dislikesCount!: number;
  @Column({ type: "enum", enum: CommentStatus, default: CommentStatus.APPROVED }) status!: CommentStatus;
}
@Entity("comment_reactions")
export class FilmCommentReaction {
  @PrimaryColumn("uuid", { name: "user_id" }) userId!: string;
  @PrimaryColumn("uuid", { name: "comment_id" }) commentId!: string;
  @Column({ type: "enum", enum: ReactionType }) type!: ReactionType;
}

@Entity("items")
export class FilmItem extends FilmBase {
  @Column() name!: string;
  @Column({ type: "enum", enum: ItemType }) type!: ItemType;
  @Column({ name: "price_spirit_stones", type: "bigint", default: 0 }) priceSpiritStones!: string;
  @Column({ name: "image_url", type: "varchar", nullable: true }) imageUrl!: string | null;
  @Column({ name: "asset_config", type: "jsonb", nullable: true }) assetConfig!: Record<string, unknown> | null;
  @Column({ name: "is_purchasable", default: true }) isPurchasable!: boolean;
}
@Index(["userId", "itemId"], { unique: true })
@Entity("user_inventories")
export class FilmUserInventory extends FilmBase {
  @Index() @Column("uuid", { name: "user_id" }) userId!: string;
  @Column("uuid", { name: "item_id" }) itemId!: string;
  @Column({ name: "is_equipped", default: false }) isEquipped!: boolean;
  @Column({ name: "acquired_at", type: "timestamptz", default: () => "now()" }) acquiredAt!: Date;
  @Column({ name: "expires_at", type: "timestamptz", nullable: true }) expiresAt!: Date | null;
}

@Entity("donations")
export class FilmDonation extends FilmBase {
  @Index() @Column("uuid", { name: "user_id" }) userId!: string;
  @Column("uuid", { name: "movie_id", nullable: true }) movieId!: string | null;
  @Column({ name: "amount_vnd", type: "numeric", precision: 15, scale: 2 }) amountVnd!: string;
  @Column({ name: "spirit_stones_converted", type: "bigint" }) spiritStonesConverted!: string;
  @Column({ name: "payment_method", type: "enum", enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @Index({ unique: true }) @Column({ name: "transaction_code" }) transactionCode!: string;
  @Column({ type: "enum", enum: DonationStatus, default: DonationStatus.PENDING }) status!: DonationStatus;
  @Column({ type: "varchar", nullable: true }) message!: string | null;
  @Column({ name: "reward_applied_at", type: "timestamptz", nullable: true }) rewardAppliedAt!: Date | null;
}
@Entity("world_chat_messages")
export class FilmChatMessage extends FilmBase {
  @Index() @Column("uuid", { name: "user_id" }) userId!: string;
  @Column({ name: "room_channel", default: "WORLD_GENERAL" }) roomChannel!: string;
  @Column("text") message!: string;
  @Column({ name: "user_snapshot", type: "jsonb" }) userSnapshot!: Record<string, unknown>;
  @Column({ type: "enum", enum: ChatType, default: ChatType.TEXT }) type!: ChatType;
}
@Entity("notifications")
export class FilmNotification extends FilmBase {
  @Index() @Column("uuid", { name: "user_id", nullable: true }) userId!: string | null;
  @Column() type!: string;
  @Column() title!: string;
  @Column("text") content!: string;
  @Column({ name: "action_url", type: "varchar", nullable: true }) actionUrl!: string | null;
  @Column({ name: "is_read", default: false }) isRead!: boolean;
}
@Entity("banners")
export class FilmBanner extends FilmBase {
  @Column() title!: string;
  @Column({ name: "image_url" }) imageUrl!: string;
  @Column({ name: "target_url" }) targetUrl!: string;
  @Column() position!: string;
  @Column({ name: "display_order", default: 0 }) displayOrder!: number;
  @Column({ name: "is_active", default: true }) isActive!: boolean;
  @Column({ name: "start_time", type: "timestamptz", nullable: true }) startTime!: Date | null;
  @Column({ name: "end_time", type: "timestamptz", nullable: true }) endTime!: Date | null;
}
@Entity("advertisements")
export class FilmAdvertisement extends FilmBase {
  @Column() name!: string;
  @Column() position!: string;
  @Column() type!: string;
  @Column({ name: "media_url", type: "varchar", nullable: true }) mediaUrl!: string | null;
  @Column({ name: "target_url", type: "varchar", nullable: true }) targetUrl!: string | null;
  @Column({ name: "script_code", type: "text", nullable: true, select: false }) scriptCode!: string | null;
  @Column({ name: "frequency_cap_per_user", default: 1 }) frequencyCapPerUser!: number;
  @Column({ name: "is_active", default: true }) isActive!: boolean;
}
@Entity("user_activity_logs")
export class FilmActivityLog {
  @PrimaryGeneratedColumn("uuid") id!: string;
  @Index() @Column("uuid", { name: "user_id", nullable: true }) userId!: string | null;
  @Index() @Column("uuid", { name: "device_id", nullable: true }) deviceId!: string | null;
  @Column({ length: 100 }) action!: string;
  @Column({ name: "target_type", type: "varchar", length: 100, nullable: true }) targetType!: string | null;
  @Column({ name: "target_id", type: "varchar", length: 150, nullable: true }) targetId!: string | null;
  @Column({ type: "jsonb", nullable: true }) payload!: Record<string, unknown> | null;
  @Column({ type: "varchar", nullable: true }) page!: string | null;
  @Column({ type: "varchar", nullable: true }) referrer!: string | null;
  @Column({ name: "ip_address", type: "varchar", length: 64, nullable: true }) ipAddress!: string | null;
  @Column({ name: "user_agent", type: "text", nullable: true }) userAgent!: string | null;
  @Index() @CreateDateColumn({ name: "created_at" }) createdAt!: Date;
}

export const FILM_DB_ENTITIES = [
  FilmDevice,
  FilmUser,
  FilmMovie,
  FilmGenre,
  FilmTag,
  FilmMovieGenre,
  FilmMovieTag,
  FilmEpisode,
  FilmEpisodeSource,
  FilmWatchHistory,
  FilmFavorite,
  FilmRating,
  FilmComment,
  FilmCommentReaction,
  FilmItem,
  FilmUserInventory,
  FilmDonation,
  FilmChatMessage,
  FilmNotification,
  FilmBanner,
  FilmAdvertisement,
  FilmActivityLog,
];
