import { MigrationInterface, QueryRunner } from "typeorm";
import { FILM_TITLE_ITEM_SEED } from "../../seeds/film-title-items.seed";
import {
  CULTIVATION_RANKS_SETTING_KEY,
  DEFAULT_CULTIVATION_RANKS,
} from "../../../film/shared/film-rank.util";

const LEGACY_STAGE_SUFFIXES = ["_so_ky", "_trung_ky", "_hau_ky", "_dinh_phong"] as const;
const REALM_PREFIXES = [
  "luyen_khi",
  "truc_co",
  "kim_dan",
  "nguyen_anh",
  "hoa_than",
  "luyen_hu",
] as const;

export class SimplifyFilmTitlesAndSeedExpConfig1900000000008 implements MigrationInterface {
  name = "SimplifyFilmTitlesAndSeedExpConfig1900000000008";

  async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Upsert the 6 simplified cultivation title items + tac_gia_canh
    for (const item of FILM_TITLE_ITEM_SEED) {
      const assetConfig = {
        slug: item.slug,
        width: item.width,
        height: item.height,
        slot: "TITLE",
        rank: item.rank,
        minExp: item.minExp,
        nextExp: item.nextExp,
        order: item.order,
      };
      const imageUrl = `/effects/title/${item.slug}.webp`;

      await queryRunner.query(
        `INSERT INTO items(name, type, price_spirit_stones, image_url, asset_config, is_purchasable)
         SELECT $2, 'TITLE', 0, $3, $4::jsonb, false
         WHERE NOT EXISTS (
           SELECT 1 FROM items WHERE type = 'TITLE' AND asset_config->>'slug' = $1
         )`,
        [item.slug, item.name, imageUrl, JSON.stringify(assetConfig)],
      );

      await queryRunner.query(
        `UPDATE items
         SET name = $2,
             image_url = $3,
             asset_config = $4::jsonb,
             price_spirit_stones = 0,
             is_purchasable = false,
             updated_at = now()
         WHERE type = 'TITLE' AND asset_config->>'slug' = $1`,
        [item.slug, item.name, imageUrl, JSON.stringify(assetConfig)],
      );
    }

    // 2. Migrate users.current_title & user_inventories from 24 legacy stages to 6 realms
    for (const prefix of REALM_PREFIXES) {
      const newSlug = `${prefix}_ky`;
      const legacySlugs = LEGACY_STAGE_SUFFIXES.map((suffix) => `${prefix}${suffix}`);

      await queryRunner.query(
        `UPDATE users
         SET current_title = $1, updated_at = now()
         WHERE current_title = ANY($2::text[])`,
        [newSlug, legacySlugs],
      );

      await queryRunner.query(
        `INSERT INTO user_inventories (user_id, item_id, is_equipped, acquired_at, expires_at)
         SELECT DISTINCT ON (inv.user_id)
           inv.user_id,
           new_item.id,
           bool_or(inv.is_equipped) OVER (PARTITION BY inv.user_id),
           min(inv.acquired_at) OVER (PARTITION BY inv.user_id),
           NULL
         FROM user_inventories inv
         INNER JOIN items old_item ON old_item.id = inv.item_id
         CROSS JOIN LATERAL (
           SELECT id FROM items WHERE type = 'TITLE' AND asset_config->>'slug' = $1 LIMIT 1
         ) new_item
         WHERE old_item.type = 'TITLE'
           AND old_item.asset_config->>'slug' = ANY($2::text[])
         ON CONFLICT (user_id, item_id) DO UPDATE
         SET is_equipped = user_inventories.is_equipped OR EXCLUDED.is_equipped,
             updated_at = now()`,
        [newSlug, legacySlugs],
      );

      await queryRunner.query(
        `DELETE FROM user_inventories inv
         USING items old_item
         WHERE inv.item_id = old_item.id
           AND old_item.type = 'TITLE'
           AND old_item.asset_config->>'slug' = ANY($1::text[])`,
        [legacySlugs],
      );

      await queryRunner.query(
        `DELETE FROM items
         WHERE type = 'TITLE'
           AND asset_config->>'slug' = ANY($1::text[])`,
        [legacySlugs],
      );
    }

    // 3. Seed CULTIVATION_RANKS into settings table so EXP thresholds are stored in DB config
    await queryRunner.query(
      `INSERT INTO "settings" ("key", "value", "description", "is_public")
       VALUES ($1, $2::jsonb, 'Cấu hình mốc EXP và danh hiệu 6 cảnh giới tu luyện', true)
       ON CONFLICT ("key") DO UPDATE
       SET "value" = EXCLUDED."value",
           "description" = EXCLUDED."description",
           "updated_at" = now()`,
      [CULTIVATION_RANKS_SETTING_KEY, JSON.stringify(DEFAULT_CULTIVATION_RANKS)],
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "settings" WHERE "key" = $1`, [
      CULTIVATION_RANKS_SETTING_KEY,
    ]);
  }
}

