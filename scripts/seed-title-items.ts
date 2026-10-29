import "dotenv/config";
import { Client } from "pg";

const TITLE_ITEMS = [
  { slug: "luyen_khi_so_ky", name: "Luyện Khí - Sơ Kỳ", width: 256, height: 82 },
  { slug: "luyen_khi_trung_ky", name: "Luyện Khí - Trung Kỳ", width: 256, height: 82 },
  { slug: "luyen_khi_hau_ky", name: "Luyện Khí - Hậu Kỳ", width: 256, height: 82 },
  { slug: "luyen_khi_dinh_phong", name: "Luyện Khí - Đỉnh Phong", width: 527, height: 198 },
  { slug: "truc_co_so_ky", name: "Trúc Cơ - Sơ Kỳ", width: 507, height: 158 },
  { slug: "truc_co_trung_ky", name: "Trúc Cơ - Trung Kỳ", width: 524, height: 161 },
  { slug: "truc_co_hau_ky", name: "Trúc Cơ - Hậu Kỳ", width: 512, height: 175 },
  { slug: "truc_co_dinh_phong", name: "Trúc Cơ - Đỉnh Phong", width: 533, height: 179 },
  { slug: "kim_dan_so_ky", name: "Kim Đan - Sơ Kỳ", width: 517, height: 114 },
  { slug: "kim_dan_trung_ky", name: "Kim Đan - Trung Kỳ", width: 531, height: 124 },
  { slug: "kim_dan_hau_ky", name: "Kim Đan - Hậu Kỳ", width: 531, height: 169 },
  { slug: "kim_dan_dinh_phong", name: "Kim Đan - Đỉnh Phong", width: 530, height: 162 },
  { slug: "nguyen_anh_so_ky", name: "Nguyên Anh - Sơ Kỳ", width: 512, height: 158 },
  { slug: "nguyen_anh_trung_ky", name: "Nguyên Anh - Trung Kỳ", width: 509, height: 160 },
  { slug: "nguyen_anh_hau_ky", name: "Nguyên Anh - Hậu Kỳ", width: 522, height: 173 },
  { slug: "nguyen_anh_dinh_phong", name: "Nguyên Anh - Đỉnh Phong", width: 514, height: 173 },
  { slug: "hoa_than_so_ky", name: "Hóa Thần - Sơ Kỳ", width: 517, height: 119 },
  { slug: "hoa_than_trung_ky", name: "Hóa Thần - Trung Kỳ", width: 531, height: 133 },
  { slug: "hoa_than_hau_ky", name: "Hóa Thần - Hậu Kỳ", width: 532, height: 179 },
  { slug: "hoa_than_dinh_phong", name: "Hóa Thần - Đỉnh Phong", width: 541, height: 208 },
  { slug: "luyen_hu_so_ky", name: "Luyện Hư - Sơ Kỳ", width: 473, height: 183 },
  { slug: "luyen_hu_trung_ky", name: "Luyện Hư - Trung Kỳ", width: 466, height: 193 },
  { slug: "luyen_hu_hau_ky", name: "Luyện Hư - Hậu Kỳ", width: 466, height: 197 },
  { slug: "luyen_hu_dinh_phong", name: "Luyện Hư - Đỉnh Phong", width: 470, height: 192 },
  { slug: "tac_gia_canh", name: "Tác Giả Cảnh", width: 543, height: 181 },
];

async function main() {
  const host = process.env.FILM_DB_HOST || "localhost";
  const port = Number(process.env.FILM_DB_PORT || 5432);
  const user = process.env.FILM_DB_USER || "postgres";
  const password = process.env.FILM_DB_PASSWORD || "1231";
  const database = process.env.FILM_DB_NAME || "kitlabs_film";

  const client = new Client({ host, port, user, password, database });
  await client.connect();

  console.log(`Connected to database: ${database} (${host}:${port})`);

  try {
    await client.query("BEGIN");

    for (const item of TITLE_ITEMS) {
      const assetConfig = {
        slot: "TITLE",
        slug: item.slug,
        width: item.width,
        height: item.height,
      };
      const imageUrl = `/effects/title/${item.slug}.png`;

      await client.query(
        `INSERT INTO items (name, type, price_spirit_stones, image_url, asset_config, is_purchasable)
         SELECT $1, 'TITLE', 0, $2, $3::jsonb, false
         WHERE NOT EXISTS (
           SELECT 1 FROM items WHERE type = 'TITLE' AND asset_config->>'slug' = $4
         )`,
        [item.name, imageUrl, JSON.stringify(assetConfig), item.slug]
      );

      await client.query(
        `UPDATE items
         SET name = $1,
             image_url = $2,
             asset_config = $3::jsonb,
             price_spirit_stones = 0,
             is_purchasable = false,
             updated_at = now()
         WHERE type = 'TITLE' AND asset_config->>'slug' = $4`,
        [item.name, imageUrl, JSON.stringify(assetConfig), item.slug]
      );
    }

    await client.query("COMMIT");

    console.log(`✅ Seeded ${TITLE_ITEMS.length} title items successfully!`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error seeding title items:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
