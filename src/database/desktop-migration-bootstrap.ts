import { DataSource, type QueryRunner } from "typeorm";

const TOOL_INIT_MIGRATION = "InitSchema1800000000000";
const AUDIT_INIT_MIGRATION = "InitAuditSchema1800000000000";
const TOOL_INIT_TIMESTAMP = 1800000000000;
const AUDIT_INIT_TIMESTAMP = 1800000000000;

type MigrationState = "complete" | "legacy" | "orphaned" | "fresh";

type DbConnection = {
  database: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
};

function pgBool(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "t" || normalized === "true" || normalized === "1";
  }
  return false;
}

function connectionOptions(connection: DbConnection) {
  return {
    host: connection.host ?? process.env.TOOL_DB_HOST ?? process.env.MAIN_DB_HOST ?? "127.0.0.1",
    port: Number(connection.port ?? process.env.TOOL_DB_PORT ?? process.env.MAIN_DB_PORT ?? 5432),
    username: connection.user ?? process.env.TOOL_DB_USER ?? process.env.MAIN_DB_USER ?? "postgres",
    password:
      connection.password ?? process.env.TOOL_DB_PASSWORD ?? process.env.MAIN_DB_PASSWORD ?? "postgres",
  };
}

function createDataSource(connection: DbConnection, database?: string): DataSource {
  return new DataSource({
    type: "postgres",
    ...connectionOptions(connection),
    database: database ?? connection.database,
    synchronize: false,
    entities: [],
    migrations: [],
  });
}

async function withQueryRunner<T>(
  connection: DbConnection,
  database: string,
  fn: (queryRunner: QueryRunner) => Promise<T>,
): Promise<T> {
  const dataSource = createDataSource(connection, database);
  await dataSource.initialize();
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    return await fn(queryRunner);
  } finally {
    await queryRunner.release();
    await dataSource.destroy();
  }
}

async function migrationsTableExists(queryRunner: QueryRunner): Promise<boolean> {
  const rows = await queryRunner.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'migrations'
    ) AS exists`,
  );
  return pgBool(rows[0]?.exists);
}

async function migrationRecorded(queryRunner: QueryRunner, name: string): Promise<boolean> {
  if (!(await migrationsTableExists(queryRunner))) return false;
  const rows = await queryRunner.query(`SELECT 1 FROM migrations WHERE name = $1 LIMIT 1`, [name]);
  return Array.isArray(rows) && rows.length > 0;
}

async function legacyMigrationCount(queryRunner: QueryRunner): Promise<number> {
  if (!(await migrationsTableExists(queryRunner))) return 0;
  const rows = await queryRunner.query(`SELECT COUNT(*)::text AS count FROM migrations`);
  return Number(rows[0]?.count ?? 0);
}

async function isCompleteLegacySchema(queryRunner: QueryRunner): Promise<boolean> {
  const rows = await queryRunner.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users'
    ) AS exists`,
  );
  return pgBool(rows[0]?.exists);
}

async function toolSchemaHasArtifacts(queryRunner: QueryRunner): Promise<boolean> {
  const enumRows = await queryRunner.query(
    `SELECT EXISTS (
      SELECT 1
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = 'download_histories_source_type_enum'
    ) AS exists`,
  );
  if (pgBool(enumRows[0]?.exists)) return true;

  const tableRows = await queryRunner.query(
    `SELECT COUNT(*)::text AS count
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name <> 'migrations'`,
  );
  return Number(tableRows[0]?.count ?? 0) > 0;
}

async function auditSchemaHasArtifacts(queryRunner: QueryRunner): Promise<boolean> {
  const rows = await queryRunner.query(
    `SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'spam_logs'
    ) AS exists`,
  );
  return pgBool(rows[0]?.exists);
}

async function resolveMigrationState(
  queryRunner: QueryRunner,
  initMigration: string,
  hasArtifacts: (runner: QueryRunner) => Promise<boolean>,
): Promise<MigrationState> {
  if (await migrationRecorded(queryRunner, initMigration)) return "complete";

  const artifacts = await hasArtifacts(queryRunner);
  if (!artifacts) return "fresh";

  const legacyCount = await legacyMigrationCount(queryRunner);
  if (legacyCount > 0 && (await isCompleteLegacySchema(queryRunner))) {
    return "legacy";
  }

  return "orphaned";
}

async function recreateDatabase(connection: DbConnection, database: string): Promise<void> {
  console.warn(`[desktop-migrations] Recreating database ${database}`);
  await withQueryRunner(connection, "postgres", async (queryRunner) => {
    await queryRunner.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
    await queryRunner.query(`DROP DATABASE IF EXISTS "${database}"`);
    await queryRunner.query(`CREATE DATABASE "${database}"`);
  });
}

async function baselineInitMigration(
  queryRunner: QueryRunner,
  initMigration: string,
  timestamp: number,
  database: string,
): Promise<void> {
  console.warn(`[desktop-migrations] Baseline squashed migration in ${database}: ${initMigration}`);
  await queryRunner.query(`INSERT INTO migrations (timestamp, name) VALUES ($1, $2)`, [
    timestamp,
    initMigration,
  ]);
}

async function prepareDatabase(
  connection: DbConnection,
  initMigration: string,
  initTimestamp: number,
  hasArtifacts: (runner: QueryRunner) => Promise<boolean>,
): Promise<void> {
  const state = await withQueryRunner(connection, connection.database, async (queryRunner) =>
    resolveMigrationState(queryRunner, initMigration, hasArtifacts),
  );

  console.log(`[desktop-migrations] ${connection.database}: ${state}`);

  if (state === "orphaned") {
    await recreateDatabase(connection, connection.database);
    return;
  }

  if (state === "legacy") {
    await withQueryRunner(connection, connection.database, async (queryRunner) => {
      await baselineInitMigration(queryRunner, initMigration, initTimestamp, connection.database);
    });
  }
}

export async function ensureDesktopMigrationBaseline(): Promise<void> {
  await prepareDatabase(
    { database: process.env.TOOL_DB_NAME ?? "kitools" },
    TOOL_INIT_MIGRATION,
    TOOL_INIT_TIMESTAMP,
    toolSchemaHasArtifacts,
  );
  await prepareDatabase(
    {
      database: process.env.AUDIT_DB_NAME ?? "kitools_audit",
      host: process.env.AUDIT_DB_HOST ?? process.env.TOOL_DB_HOST,
      port: Number(process.env.AUDIT_DB_PORT ?? process.env.TOOL_DB_PORT ?? 5432),
      user: process.env.AUDIT_DB_USER ?? process.env.TOOL_DB_USER,
      password: process.env.AUDIT_DB_PASSWORD ?? process.env.TOOL_DB_PASSWORD,
    },
    AUDIT_INIT_MIGRATION,
    AUDIT_INIT_TIMESTAMP,
    auditSchemaHasArtifacts,
  );
}
