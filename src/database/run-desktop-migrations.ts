import { config } from "dotenv";

config({ path: process.env.DOTENV_CONFIG_PATH || undefined });

import auditDs from "./data-source.audit";
import mainDs from "./data-source.main";
import toolDs from "./data-source.tool";
import { ensureDesktopMigrationBaseline } from "./desktop-migration-bootstrap";

async function run(): Promise<void> {
  await ensureDesktopMigrationBaseline();

  const tool = await toolDs.initialize();
  try {
    await tool.runMigrations();
  } finally {
    await tool.destroy();
  }

  const main = await mainDs.initialize();
  try {
    await main.runMigrations();
  } finally {
    await main.destroy();
  }

  const audit = await auditDs.initialize();
  try {
    await audit.runMigrations();
  } finally {
    await audit.destroy();
  }
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
