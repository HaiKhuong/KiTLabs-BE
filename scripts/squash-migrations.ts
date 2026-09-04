/**
 * Wipes kitools + kitools_audit schemas and generates fresh squashed migrations from entities.
 * Usage: npx ts-node --transpile-only scripts/squash-migrations.ts
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";

import auditDs from "../src/database/data-source.audit";
import toolDs from "../src/database/data-source.tool";

const ROOT = path.join(__dirname, "..");
const MAIN_MIGRATIONS_DIR = path.join(ROOT, "src/database/migrations/main");
const AUDIT_MIGRATIONS_DIR = path.join(ROOT, "src/database/migrations/audit");

async function wipeSchema(ds: typeof toolDs, label: string) {
  await ds.initialize();
  const db = (ds.options as { database?: string }).database;
  console.log(`Resetting schema on ${label} (${db})…`);
  await ds.query(`DROP SCHEMA IF EXISTS public CASCADE`);
  await ds.query(`CREATE SCHEMA public`);
  await ds.query(`GRANT ALL ON SCHEMA public TO postgres`);
  await ds.query(`GRANT ALL ON SCHEMA public TO public`);
  await ds.destroy();
}

function removeMigrations(dir: string) {
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith(".ts") || file.endsWith(".js")) {
      fs.unlinkSync(path.join(dir, file));
    }
  }
}

function renameGeneratedMigration(dir: string, finalName: string) {
  const generated = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f.includes("Init"))
    .sort();
  if (generated.length !== 1) {
    throw new Error(`Expected one generated migration in ${dir}, found: ${generated.join(", ")}`);
  }
  const from = path.join(dir, generated[0]);
  const to = path.join(dir, finalName);
  fs.renameSync(from, to);
  const base = finalName.replace(/\.ts$/, "");
  const className = base.replace(/^\d+-/, "").replace(/-/g, "") + base.match(/^(\d+)/)?.[1];
  let content = fs.readFileSync(to, "utf8");
  const classMatch = content.match(/export class (\w+)/);
  if (classMatch) {
    content = content.replace(classMatch[0], `export class ${className}`);
    content = content.replace(/name = ['"][^'"]+['"]/, `name = '${className}'`);
    fs.writeFileSync(to, content, "utf8");
  }
  console.log(`  → ${finalName} (${className})`);
}

async function main() {
  removeMigrations(MAIN_MIGRATIONS_DIR);
  removeMigrations(AUDIT_MIGRATIONS_DIR);
  console.log("Removed old migrations.");

  await wipeSchema(toolDs, "tool/main");
  await wipeSchema(auditDs, "audit");

  console.log("Generating main schema migration from entities…");
  execSync(
    "npx typeorm-ts-node-commonjs -d src/database/data-source.tool.ts migration:generate src/database/migrations/main/InitSchema",
    { cwd: ROOT, stdio: "inherit" },
  );
  renameGeneratedMigration(MAIN_MIGRATIONS_DIR, "1800000000000-InitSchema.ts");

  console.log("Generating audit schema migration from entities…");
  execSync(
    "npx typeorm-ts-node-commonjs -d src/database/data-source.audit.ts migration:generate src/database/migrations/audit/InitAuditSchema",
    { cwd: ROOT, stdio: "inherit" },
  );
  renameGeneratedMigration(AUDIT_MIGRATIONS_DIR, "1800000000000-InitAuditSchema.ts");

  console.log("Done. Run migration:run or restart desktop app to apply.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
