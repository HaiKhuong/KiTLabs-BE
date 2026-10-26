import "dotenv/config";
import { Client } from "pg";

async function main() {
  const database = process.env.FILM_DB_NAME ?? "kitlabs_film";
  if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error("FILM_DB_NAME contains invalid characters");
  const client = new Client({
    host: process.env.FILM_DB_HOST ?? "localhost",
    port: Number(process.env.FILM_DB_PORT ?? 5432),
    user: process.env.FILM_DB_USER ?? "postgres",
    password: process.env.FILM_DB_PASSWORD ?? "postgres",
    database: "postgres",
  });
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (existing.rowCount) {
      console.log(`Database ${database} already exists`);
      return;
    }
    await client.query(`CREATE DATABASE "${database}"`);
    console.log(`Database ${database} created`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
