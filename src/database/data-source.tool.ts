import "dotenv/config";

import { DataSource } from "typeorm";

import { TOOL_DB_ENTITIES } from "./entities/tool.entities";

export default new DataSource({
  name: "tool",
  type: "postgres",
  host: process.env.TOOL_DB_HOST ?? process.env.DB_HOST ?? "localhost",
  port: Number(process.env.TOOL_DB_PORT ?? process.env.DB_PORT ?? 5432),
  username: process.env.TOOL_DB_USER ?? process.env.DB_USER ?? "postgres",
  password: process.env.TOOL_DB_PASSWORD ?? process.env.DB_PASSWORD ?? "postgres",
  database: process.env.TOOL_DB_NAME ?? process.env.DB_NAME ?? "kitools",
  synchronize: false,
  entities: TOOL_DB_ENTITIES,
  migrations: ["src/database/migrations/main/*{.ts,.js}"],
});
