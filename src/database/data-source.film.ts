import "dotenv/config";
import { join } from "path";
import { DataSource } from "typeorm";
import { FILM_DB_ENTITIES } from "./entities/film.entities";

export default new DataSource({
  name: "film",
  type: "postgres",
  host: process.env.FILM_DB_HOST || "localhost",
  port: Number(process.env.FILM_DB_PORT || 5432),
  username: process.env.FILM_DB_USER || "postgres",
  password: process.env.FILM_DB_PASSWORD || "postgres",
  database: process.env.FILM_DB_NAME || "kitlabs_film",
  synchronize: false,
  entities: FILM_DB_ENTITIES,
  migrations: [join(__dirname, "migrations/film/*{.ts,.js}")],
  migrationsTransactionMode: "each",
});
