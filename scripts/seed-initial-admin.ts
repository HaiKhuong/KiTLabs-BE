import "dotenv/config";
import * as bcrypt from "bcrypt";
import { Client } from "pg";

async function main() {
  const host = process.env.DB_HOST ?? "localhost";
  const port = Number(process.env.DB_PORT ?? 5432);
  const user = process.env.DB_USER ?? "postgres";
  const password = process.env.DB_PASSWORD ?? "postgres";

  const email = (process.env.FILM_ADMIN_EMAIL || process.env.PLATFORM_ADMIN_EMAIL || "admin@kitlabs.io").trim().toLowerCase();
  const rawPassword = process.env.FILM_ADMIN_PASSWORD || process.env.PLATFORM_ADMIN_PASSWORD || "Admin@123456";
  const username = (process.env.FILM_ADMIN_USERNAME || process.env.PLATFORM_ADMIN_USERNAME || "admin").trim();
  const name = process.env.FILM_ADMIN_NAME || "Admin";

  const passwordHash = await bcrypt.hash(rawPassword, 12);

  // Seed into Platform DB and Tools DB
  const userDbs = [
    process.env.MAIN_DB_NAME || "kitlabs_platform",
    process.env.TOOL_DB_NAME || "kitlabs_tools",
  ];

  for (const dbName of Array.from(new Set(userDbs))) {
    const client = new Client({ host, port, user, password, database: dbName });
    await client.connect();
    try {
      await client.query(`
        INSERT INTO users (user_name, email, password_hash, auth_type, role, is_active)
        VALUES ($1, $2, $3, 'account', 'ADMIN', true)
        ON CONFLICT (user_name) DO UPDATE 
          SET email = EXCLUDED.email,
              password_hash = EXCLUDED.password_hash,
              role = 'ADMIN',
              is_active = true
      `, [username, email, passwordHash]);
      console.log(`Seeded admin "${username}" (${email}) in ${dbName}`);
    } finally {
      await client.end();
    }
  }

  // Seed into Film DB
  const filmDbName = process.env.FILM_DB_NAME || "kitlabs_film";
  const clientFilm = new Client({ host, port, user, password, database: filmDbName });
  await clientFilm.connect();
  try {
    await clientFilm.query(`
      INSERT INTO users (name, username, email, password_hash, role, status, is_email_verified)
      VALUES ($1, $2, $3, $4, 'ADMIN', 'ACTIVE', true)
      ON CONFLICT DO NOTHING
    `, [name, username, email, passwordHash]);
    console.log(`Seeded admin "${username}" in ${filmDbName}`);
  } finally {
    await clientFilm.end();
  }
}

main().catch((err) => {
  console.error("Error seeding initial admin:", err);
  process.exit(1);
});
