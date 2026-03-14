import "dotenv/config";

import { DataSource } from "typeorm";

import { AUDIT_DB_ENTITIES } from "./entities/audit.entities";

export default new DataSource({
  type: "postgres",
  host: process.env.AUDIT_DB_HOST ?? "localhost",
  port: Number(process.env.AUDIT_DB_PORT ?? 5433),
  username: process.env.AUDIT_DB_USER ?? "postgres",
  password: process.env.AUDIT_DB_PASSWORD ?? "postgres",
  database: process.env.AUDIT_DB_NAME ?? "kitools_audit",
  synchronize: false,
  entities: AUDIT_DB_ENTITIES,
  migrations: ["src/database/migrations/audit/*{.ts,.js}"],
});
