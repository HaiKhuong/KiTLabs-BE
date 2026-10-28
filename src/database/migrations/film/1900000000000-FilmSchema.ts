import { MigrationInterface, QueryRunner } from "typeorm";

export class FilmSchema1900000000000 implements MigrationInterface {
  name = "FilmSchema1900000000000";
  async up(q: QueryRunner): Promise<void> {
    // Existing installations were created by the legacy Film schema migration.
    // Treat this squashed migration as an idempotent baseline instead of trying
    // to recreate enums and tables that are already present.
    if (await q.hasTable("movies")) return;

    await q.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    for (const [name, values] of Object.entries({
      users_role_enum: ["GUEST", "USER", "VIP", "MODERATOR", "ADMIN"],
      users_status_enum: ["ACTIVE", "BANNED", "SUSPENDED"],
      users_sect_rank_enum: ["LUYEN_KHI", "TRUC_CO", "KIM_DAN", "NGUYEN_ANH", "HOA_THAN", "LUAN_HOI", "THAN_HOANG"],
      movies_status_enum: ["ONGOING", "COMPLETED", "HIATUS"],
      episode_sources_source_type_enum: ["HLS_M3U8", "MP4", "EMBED", "IFRAME"],
      episode_sources_quality_enum: ["360P", "480P", "720P", "1080P", "4K", "AUTO"],
      items_type_enum: ["AVATAR_FRAME", "TITLE", "CHAT_EFFECT", "STICKER_PACK"],
      donations_payment_method_enum: ["MOMO", "VNPAY", "BANK_TRANSFER", "PAYPAL", "STRIPE"],
      donations_status_enum: ["PENDING", "SUCCESS", "FAILED", "REFUNDED"],
      comments_status_enum: ["APPROVED", "PENDING_MODERATION", "HIDDEN", "DELETED"],
      comment_reactions_type_enum: ["LIKE", "DISLIKE"],
      world_chat_messages_type_enum: ["TEXT", "EMOJI", "STICKER", "SYSTEM_ANNOUNCEMENT", "DONATE_ALERT"],
    }))
      await q.query(`CREATE TYPE "${name}" AS ENUM (${values.map((v) => `'${v}'`).join(",")})`);
    const base = `"id" uuid NOT NULL DEFAULT uuid_generate_v4(),"created_at" timestamptz NOT NULL DEFAULT now(),"updated_at" timestamptz NOT NULL DEFAULT now(),"deleted_at" timestamptz`;
    await q.query(
      `CREATE TABLE "devices" (${base},"device_token" varchar(100) NOT NULL,"first_ip" varchar(64),"last_ip" varchar(64),"user_agent" text,"last_seen_at" timestamptz NOT NULL,CONSTRAINT "PK_devices" PRIMARY KEY("id"),CONSTRAINT "UQ_devices_token" UNIQUE("device_token"))`,
    );
    await q.query(
      `CREATE TABLE "users" (${base},"device_id" uuid,"username" varchar(100),"email" varchar(255),"password_hash" varchar(255),"refresh_token_hash" varchar(255),"name" varchar(150) NOT NULL,"avatar_url" varchar,"avatar_frame_id" uuid,"role" users_role_enum NOT NULL DEFAULT 'GUEST',"status" users_status_enum NOT NULL DEFAULT 'ACTIVE',"sect_rank" users_sect_rank_enum NOT NULL DEFAULT 'LUYEN_KHI',"exp" bigint NOT NULL DEFAULT 0,"spirit_stones" bigint NOT NULL DEFAULT 0,"total_donated_vnd" numeric(15,2) NOT NULL DEFAULT 0,"total_view_minutes" bigint NOT NULL DEFAULT 0,"current_title" varchar,"is_email_verified" boolean NOT NULL DEFAULT false,"last_login_at" timestamptz,"last_active_at" timestamptz,CONSTRAINT "PK_users" PRIMARY KEY("id"),CONSTRAINT "FK_users_device" FOREIGN KEY("device_id") REFERENCES devices(id) ON DELETE SET NULL)`,
    );
    await q.query(
      `CREATE UNIQUE INDEX "UQ_users_device" ON users(device_id) WHERE device_id IS NOT NULL; CREATE UNIQUE INDEX "UQ_users_username" ON users(username) WHERE username IS NOT NULL; CREATE UNIQUE INDEX "UQ_users_email" ON users(email) WHERE email IS NOT NULL`,
    );
    await q.query(
      `CREATE TABLE "movies" (${base},"title" varchar NOT NULL,"slug" varchar NOT NULL,"banner_url" varchar,"status" movies_status_enum NOT NULL DEFAULT 'ONGOING',"release_year" int,"current_episode_count" int NOT NULL DEFAULT 1,"views" bigint NOT NULL DEFAULT 0,"rating_avg" numeric(3,2) NOT NULL DEFAULT 0,"rating_count" int NOT NULL DEFAULT 0,"rank_score" bigint NOT NULL DEFAULT 0,"is_hot" boolean NOT NULL DEFAULT false,"is_recommended" boolean NOT NULL DEFAULT false,CONSTRAINT "PK_movies" PRIMARY KEY("id"),CONSTRAINT "UQ_movies_slug" UNIQUE("slug"))`,
    );
    await q.query(
      `CREATE INDEX "IDX_movies_title" ON movies(title); CREATE INDEX "IDX_movies_views" ON movies(views); CREATE INDEX "IDX_movies_rank" ON movies(rank_score)`,
    );
    await q.query(
      `CREATE TABLE "genres" (${base},"name" varchar NOT NULL,"slug" varchar NOT NULL,"description" varchar,CONSTRAINT "PK_genres" PRIMARY KEY("id"),UNIQUE("name"),UNIQUE("slug")); CREATE TABLE "tags" (${base},"name" varchar NOT NULL,"code" varchar NOT NULL,CONSTRAINT "PK_tags" PRIMARY KEY("id"),UNIQUE("name"),UNIQUE("code"))`,
    );
    await q.query(
      `CREATE TABLE "movie_genres" ("movie_id" uuid NOT NULL,"genre_id" uuid NOT NULL,PRIMARY KEY("movie_id","genre_id"),FOREIGN KEY("movie_id") REFERENCES movies(id) ON DELETE CASCADE,FOREIGN KEY("genre_id") REFERENCES genres(id) ON DELETE CASCADE); CREATE TABLE "movie_tags" ("movie_id" uuid NOT NULL,"tag_id" uuid NOT NULL,PRIMARY KEY("movie_id","tag_id"),FOREIGN KEY("movie_id") REFERENCES movies(id) ON DELETE CASCADE,FOREIGN KEY("tag_id") REFERENCES tags(id) ON DELETE CASCADE)`,
    );
    await q.query(
      `CREATE TABLE "episodes" (${base},"movie_id" uuid NOT NULL,"episode_number" numeric(6,1) NOT NULL,"title" varchar,"duration_seconds" int NOT NULL DEFAULT 0,"views" bigint NOT NULL DEFAULT 0,"thumbnail_url" varchar,CONSTRAINT "PK_episodes" PRIMARY KEY("id"),CONSTRAINT "FK_episode_movie" FOREIGN KEY("movie_id") REFERENCES movies(id) ON DELETE CASCADE,UNIQUE("movie_id","episode_number"))`,
    );
    await q.query(
      `CREATE TABLE "episode_sources" (${base},"episode_id" uuid NOT NULL,"server_name" varchar NOT NULL,"source_type" episode_sources_source_type_enum NOT NULL,"quality" episode_sources_quality_enum NOT NULL,"video_url" text NOT NULL,"is_active" boolean NOT NULL DEFAULT true,"priority" int NOT NULL DEFAULT 1,CONSTRAINT "PK_episode_sources" PRIMARY KEY("id"),FOREIGN KEY("episode_id") REFERENCES episodes(id) ON DELETE CASCADE)`,
    );
    await q.query(
      `CREATE TABLE "watch_histories" (${base},"user_id" uuid NOT NULL,"movie_id" uuid NOT NULL,"episode_id" uuid NOT NULL,"stopped_at_seconds" int NOT NULL DEFAULT 0,"watched_minutes" int NOT NULL DEFAULT 0,CONSTRAINT "PK_watch_histories" PRIMARY KEY("id"),UNIQUE("user_id","episode_id"),FOREIGN KEY("user_id") REFERENCES users(id),FOREIGN KEY("movie_id") REFERENCES movies(id),FOREIGN KEY("episode_id") REFERENCES episodes(id))`,
    );
    await q.query(
      `CREATE TABLE "favorites" (${base},"user_id" uuid NOT NULL,"movie_id" uuid NOT NULL,CONSTRAINT "PK_favorites" PRIMARY KEY("id"),UNIQUE("user_id","movie_id"),FOREIGN KEY("user_id") REFERENCES users(id),FOREIGN KEY("movie_id") REFERENCES movies(id)); CREATE TABLE "ratings" (${base},"user_id" uuid NOT NULL,"movie_id" uuid NOT NULL,"score" int NOT NULL CHECK(score BETWEEN 1 AND 5),"review" text,CONSTRAINT "PK_ratings" PRIMARY KEY("id"),UNIQUE("user_id","movie_id"),FOREIGN KEY("user_id") REFERENCES users(id),FOREIGN KEY("movie_id") REFERENCES movies(id))`,
    );
    await q.query(
      `CREATE TABLE "comments" (${base},"user_id" uuid NOT NULL,"movie_id" uuid NOT NULL,"episode_id" uuid,"parent_id" uuid,"content" text NOT NULL,"user_sect_rank_snapshot" varchar NOT NULL,"is_spoil" boolean NOT NULL DEFAULT false,"likes_count" int NOT NULL DEFAULT 0,"dislikes_count" int NOT NULL DEFAULT 0,"status" comments_status_enum NOT NULL DEFAULT 'APPROVED',CONSTRAINT "PK_comments" PRIMARY KEY("id"),FOREIGN KEY("user_id") REFERENCES users(id),FOREIGN KEY("movie_id") REFERENCES movies(id),FOREIGN KEY("episode_id") REFERENCES episodes(id),FOREIGN KEY("parent_id") REFERENCES comments(id))`,
    );
    await q.query(
      `CREATE TABLE "comment_reactions" ("user_id" uuid NOT NULL,"comment_id" uuid NOT NULL,"type" comment_reactions_type_enum NOT NULL,PRIMARY KEY("user_id","comment_id"),FOREIGN KEY("user_id") REFERENCES users(id),FOREIGN KEY("comment_id") REFERENCES comments(id) ON DELETE CASCADE)`,
    );
    await q.query(
      `CREATE TABLE "items" (${base},"name" varchar NOT NULL,"type" items_type_enum NOT NULL,"price_spirit_stones" bigint NOT NULL DEFAULT 0,"image_url" varchar,"asset_config" jsonb,"is_purchasable" boolean NOT NULL DEFAULT true,CONSTRAINT "PK_items" PRIMARY KEY("id")); CREATE TABLE "user_inventories" (${base},"user_id" uuid NOT NULL,"item_id" uuid NOT NULL,"is_equipped" boolean NOT NULL DEFAULT false,"acquired_at" timestamptz NOT NULL DEFAULT now(),"expires_at" timestamptz,CONSTRAINT "PK_user_inventories" PRIMARY KEY("id"),UNIQUE("user_id","item_id"),FOREIGN KEY("user_id") REFERENCES users(id),FOREIGN KEY("item_id") REFERENCES items(id))`,
    );
    await q.query(
      `CREATE TABLE "donations" (${base},"user_id" uuid NOT NULL,"movie_id" uuid,"amount_vnd" numeric(15,2) NOT NULL,"spirit_stones_converted" bigint NOT NULL,"payment_method" donations_payment_method_enum NOT NULL,"transaction_code" varchar NOT NULL,"status" donations_status_enum NOT NULL DEFAULT 'PENDING',"message" varchar,"reward_applied_at" timestamptz,CONSTRAINT "PK_donations" PRIMARY KEY("id"),UNIQUE("transaction_code"),FOREIGN KEY("user_id") REFERENCES users(id),FOREIGN KEY("movie_id") REFERENCES movies(id))`,
    );
    await q.query(
      `CREATE TABLE "world_chat_messages" (${base},"user_id" uuid NOT NULL,"room_channel" varchar NOT NULL DEFAULT 'WORLD_GENERAL',"message" text NOT NULL,"user_snapshot" jsonb NOT NULL,"type" world_chat_messages_type_enum NOT NULL DEFAULT 'TEXT',CONSTRAINT "PK_world_chat" PRIMARY KEY("id"),FOREIGN KEY("user_id") REFERENCES users(id)); CREATE INDEX "IDX_world_chat_room_created" ON world_chat_messages(room_channel,created_at DESC)`,
    );
    await q.query(
      `CREATE TABLE "notifications" (${base},"user_id" uuid,"type" varchar NOT NULL,"title" varchar NOT NULL,"content" text NOT NULL,"action_url" varchar,"is_read" boolean NOT NULL DEFAULT false,CONSTRAINT "PK_notifications" PRIMARY KEY("id"),FOREIGN KEY("user_id") REFERENCES users(id) ON DELETE CASCADE)`,
    );
    await q.query(
      `CREATE TABLE "banners" (${base},"title" varchar NOT NULL,"image_url" varchar NOT NULL,"target_url" varchar NOT NULL,"position" varchar NOT NULL,"display_order" int NOT NULL DEFAULT 0,"is_active" boolean NOT NULL DEFAULT true,"start_time" timestamptz,"end_time" timestamptz,CONSTRAINT "PK_banners" PRIMARY KEY("id")); CREATE TABLE "advertisements" (${base},"name" varchar NOT NULL,"position" varchar NOT NULL,"type" varchar NOT NULL,"media_url" varchar,"target_url" varchar,"script_code" text,"frequency_cap_per_user" int NOT NULL DEFAULT 1,"is_active" boolean NOT NULL DEFAULT true,CONSTRAINT "PK_advertisements" PRIMARY KEY("id"))`,
    );
    await q.query(
      `CREATE TABLE "user_activity_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(),"user_id" uuid,"device_id" uuid,"action" varchar(100) NOT NULL,"target_type" varchar(100),"target_id" varchar(150),"payload" jsonb,"page" varchar,"referrer" varchar,"ip_address" varchar(64),"user_agent" text,"created_at" timestamptz NOT NULL DEFAULT now(),CONSTRAINT "PK_activity_logs" PRIMARY KEY("id"),FOREIGN KEY("user_id") REFERENCES users(id) ON DELETE SET NULL,FOREIGN KEY("device_id") REFERENCES devices(id) ON DELETE SET NULL); CREATE INDEX "IDX_activity_created" ON user_activity_logs(created_at DESC); CREATE INDEX "IDX_activity_user" ON user_activity_logs(user_id)`,
    );
  }
  async down(q: QueryRunner): Promise<void> {
    for (const table of [
      "user_activity_logs",
      "advertisements",
      "banners",
      "notifications",
      "world_chat_messages",
      "donations",
      "user_inventories",
      "items",
      "comment_reactions",
      "comments",
      "ratings",
      "favorites",
      "watch_histories",
      "episode_sources",
      "episodes",
      "movie_tags",
      "movie_genres",
      "tags",
      "genres",
      "movies",
      "users",
      "devices",
    ])
      await q.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    for (const type of [
      "world_chat_messages_type_enum",
      "comment_reactions_type_enum",
      "comments_status_enum",
      "donations_status_enum",
      "donations_payment_method_enum",
      "items_type_enum",
      "episode_sources_quality_enum",
      "episode_sources_source_type_enum",
      "movies_status_enum",
      "users_sect_rank_enum",
      "users_status_enum",
      "users_role_enum",
    ])
      await q.query(`DROP TYPE IF EXISTS "${type}"`);
  }
}
