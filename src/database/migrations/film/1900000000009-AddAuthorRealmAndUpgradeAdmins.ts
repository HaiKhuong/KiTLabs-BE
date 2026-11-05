import { MigrationInterface, QueryRunner } from "typeorm";
import { FILM_TITLE_ITEM_SEED } from "../../seeds/film-title-items.seed";
import {
  CULTIVATION_RANKS_SETTING_KEY,
  DEFAULT_CULTIVATION_RANKS,
} from "../../../film/shared/film-rank.util";

export class AddAuthorRealmAndUpgradeAdmins1900000000009 implements MigrationInterface {
  name = "AddAuthorRealmAndUpgradeAdmins1900000000009";

  async up(queryRunner: QueryRunner): Promise<void> {
    const authorRealm = FILM_TITLE_ITEM_SEED.find((item) => item.slug === "tac_gia_canh");
    if (!authorRealm) throw new Error("Missing tac_gia_canh title seed");

    const assetConfig = {
      slug: authorRealm.slug,
      width: authorRealm.width,
      height: authorRealm.height,
      slot: "TITLE",
      rank: authorRealm.rank,
      minExp: authorRealm.minExp,
      nextExp: authorRealm.nextExp,
      order: authorRealm.order,
    };

    await queryRunner.query(
      `INSERT INTO items(name, type, price_spirit_stones, image_url, asset_config, is_purchasable)
       SELECT $1, 'TITLE', 0, $2, $3::jsonb, false
       WHERE NOT EXISTS (
         SELECT 1 FROM items WHERE type = 'TITLE' AND asset_config->>'slug' = 'tac_gia_canh'
       )`,
      [authorRealm.name, "/effects/title/tac_gia_canh.webp", JSON.stringify(assetConfig)],
    );

    await queryRunner.query(
      `UPDATE items
       SET name = $1, image_url = $2, asset_config = $3::jsonb,
           price_spirit_stones = 0, is_purchasable = false, updated_at = now()
       WHERE type = 'TITLE' AND asset_config->>'slug' = 'tac_gia_canh'`,
      [authorRealm.name, "/effects/title/tac_gia_canh.webp", JSON.stringify(assetConfig)],
    );

    await queryRunner.query(
      `UPDATE user_inventories inventory
       SET is_equipped = false, updated_at = now()
       FROM items item, users app_user
       WHERE inventory.item_id = item.id
         AND inventory.user_id = app_user.id
         AND app_user.role = 'ADMIN'
         AND item.type = 'TITLE'
         AND inventory.is_equipped = true`,
    );

    await queryRunner.query(
      `INSERT INTO user_inventories (user_id, item_id, is_equipped, acquired_at, expires_at)
       SELECT app_user.id, item.id, true, now(), NULL
       FROM users app_user
       CROSS JOIN items item
       WHERE app_user.role = 'ADMIN'
         AND item.type = 'TITLE'
         AND item.asset_config->>'slug' = 'tac_gia_canh'
       ON CONFLICT (user_id, item_id) DO UPDATE
       SET is_equipped = true, deleted_at = NULL, updated_at = now()`
    );

    await queryRunner.query(
      `UPDATE users
       SET current_title = 'tac_gia_canh', sect_rank = 'THAN_HOANG', exp = 999999, updated_at = now()
       WHERE role = 'ADMIN'`,
    );

    await queryRunner.query(
      `INSERT INTO settings (key, value, description, is_public)
       VALUES ($1, $2::jsonb, 'Cấu hình mốc EXP và danh hiệu cảnh giới tu luyện', true)
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, description = EXCLUDED.description, updated_at = now()`,
      [CULTIVATION_RANKS_SETTING_KEY, JSON.stringify(DEFAULT_CULTIVATION_RANKS)],
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE users
       SET current_title = 'luyen_hu_ky', sect_rank = 'LUAN_HOI', exp = 200000, updated_at = now()
       WHERE role = 'ADMIN' AND current_title = 'tac_gia_canh'`,
    );
  }
}
