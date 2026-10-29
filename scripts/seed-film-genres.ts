import "dotenv/config";
import { Client } from "pg";
import { FILM_GENRES_SEED } from "../src/database/seeds/film-genres.seed";

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

    console.log(`--> Seeding ${FILM_GENRES_SEED.length} genre badges into table "genres"...`);

    for (const g of FILM_GENRES_SEED) {
      await client.query(
        `INSERT INTO genres (name, slug, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE
           SET name = EXCLUDED.name,
               description = EXCLUDED.description,
               updated_at = now()`,
        [g.name, g.slug, g.description]
      );
    }

    await client.query("COMMIT");

    const result = await client.query(
      `SELECT name, slug, description FROM genres ORDER BY name ASC`
    );

    console.log("=========================================");
    console.log(`✅ SEED GENRES COMPLETED SUCCESSFULLY!`);
    console.log(`🏷️  Total genres in DB: ${result.rows.length}`);
    console.table(
      result.rows.map((r) => ({
        Name: r.name,
        Slug: r.slug,
        Description: (r.description || "").slice(0, 45) + "...",
      }))
    );
    console.log("=========================================");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error seeding genres:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

