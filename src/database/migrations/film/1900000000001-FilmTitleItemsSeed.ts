import { MigrationInterface, QueryRunner } from "typeorm";
import { FILM_TITLE_ITEM_SEED } from "../../seeds/film-title-items.seed";

export class FilmTitleItemsSeed1900000000001 implements MigrationInterface {
  name = "FilmTitleItemsSeed1900000000001";

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const item of FILM_TITLE_ITEM_SEED) {
      const assetConfig = {
        slug: item.slug,
        width: item.width,
        height: item.height,
        slot: "TITLE",
      };
      const imageUrl = `/effects/title/${item.slug}.png`;

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
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM items
       WHERE type = 'TITLE' AND asset_config->>'slug' = ANY($1::text[])`,
      [FILM_TITLE_ITEM_SEED.map((item) => item.slug)],
    );
  }
}

