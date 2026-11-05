import "dotenv/config";
import * as bcrypt from "bcrypt";
import { Client } from "pg";

async function main() {
  const host = process.env.DB_HOST ?? "localhost";
  const port = Number(process.env.DB_PORT ?? 5432);
  const user = process.env.DB_USER ?? "postgres";
  const password = process.env.DB_PASSWORD ?? "postgres";
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const rawPassword = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME?.trim() || "Platform Admin";
  if (!email || !rawPassword) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD are required");

  const username = email.split("@")[0].replace(/[^a-z0-9._-]/gi, "") || "admin";
  const passwordHash = await bcrypt.hash(rawPassword, 12);
  const platformClient = new Client({
    host, port, user, password, database: process.env.MAIN_DB_NAME || "kitlabs_platform",
  });

  await platformClient.connect();
  let adminId: string;
  try {
    const result = await platformClient.query<{ id: string }>(`
      INSERT INTO platform_admin_users
        (user_name, email, password_hash, full_name, role_id, is_super_admin, is_active)
      VALUES
        ($1, $2, $3, $4, (SELECT id FROM platform_admin_roles WHERE code = 'SUPER_ADMIN' LIMIT 1), true, true)
      ON CONFLICT (user_name) DO UPDATE SET
        email = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        full_name = EXCLUDED.full_name,
        role_id = COALESCE(EXCLUDED.role_id, platform_admin_users.role_id),
        is_super_admin = true,
        is_active = true
      RETURNING id
    `, [username, email, passwordHash, name]);
    adminId = result.rows[0].id;
    console.log(`Seeded Platform Admin "${username}" (${email})`);
  } finally {
    await platformClient.end();
  }

  // Password-less Film mirror for CMS relations; never used as an authentication source.
  const filmClient = new Client({
    host, port, user, password, database: process.env.FILM_DB_NAME || "kitlabs_film",
  });
  await filmClient.connect();
  try {
    await filmClient.query(`
      INSERT INTO users (id, name, username, email, password_hash, role, status, is_email_verified)
      VALUES ($1, $2, $3, $4, NULL, 'ADMIN', 'ACTIVE', true)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        username = EXCLUDED.username,
        email = EXCLUDED.email,
        password_hash = NULL,
        role = 'ADMIN',
        status = 'ACTIVE'
    `, [adminId, name, username, email]);
    console.log(`Synchronized password-less Film mirror for "${username}"`);
  } finally {
    await filmClient.end();
  }
}

main().catch((err) => {
  console.error("Error seeding initial Platform Admin:", err);
  process.exit(1);
});
