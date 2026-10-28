import "dotenv/config";
import { Client } from "pg";

const TARGET_DBS = [
  process.env.DB_NAME || "kitlabs",
  process.env.MAIN_DB_NAME || "kitlabs_platform",
  process.env.TOOL_DB_NAME || "kitlabs_tools",
  process.env.AUDIT_DB_NAME || "kitlabs_audit",
  process.env.FILM_DB_NAME || "kitlabs_film",
];

// Deduplicate in case any are identical
const uniqueDatabases = Array.from(new Set(TARGET_DBS.filter(Boolean)));

async function main() {
  const host = process.env.DB_HOST ?? "localhost";
  const port = Number(process.env.DB_PORT ?? 5432);
  const user = process.env.DB_USER ?? "postgres";
  const password = process.env.DB_PASSWORD ?? "postgres";

  const client = new Client({
    host,
    port,
    user,
    password,
    database: "postgres",
  });

  await client.connect();
  console.log(`Connected to PostgreSQL at ${host}:${port} as user "${user}"`);
  console.log("Databases to recreate:", uniqueDatabases);

  try {
    for (const db of uniqueDatabases) {
      if (!/^[a-zA-Z0-9_]+$/.test(db)) {
        throw new Error(`Database name "${db}" contains invalid characters`);
      }

      console.log(`\n--- Resetting database: "${db}" ---`);

      // Terminate any active connections to the database
      await client.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = $1
          AND pid <> pg_backend_pid()
      `, [db]);

      // Drop database if exists
      await client.query(`DROP DATABASE IF EXISTS "${db}"`);
      console.log(`Dropped database "${db}" (if existed)`);

      // Create fresh database
      await client.query(`CREATE DATABASE "${db}"`);
      console.log(`Created fresh database "${db}"`);
    }
    console.log("\nAll 5 databases recreated successfully!");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Failed to recreate databases:", err);
  process.exit(1);
});
