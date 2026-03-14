import "dotenv/config";

import { DataSource } from "typeorm";

import { MAIN_DB_ENTITIES } from "./entities/main.entities";

export default new DataSource({
  type: "postgres",
  host: process.env.MAIN_DB_HOST ?? process.env.DB_HOST ?? "localhost",
  port: Number(process.env.MAIN_DB_PORT ?? process.env.DB_PORT ?? 5432),
  username: process.env.MAIN_DB_USER ?? process.env.DB_USER ?? "postgres",
  password: process.env.MAIN_DB_PASSWORD ?? process.env.DB_PASSWORD ?? "postgres",
  database: process.env.MAIN_DB_NAME ?? process.env.DB_NAME ?? "kitools",
  synchronize: false,
  entities: MAIN_DB_ENTITIES,
  migrations: ["src/database/migrations/main/*{.ts,.js}"],
});
