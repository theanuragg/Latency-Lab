import type { Knex } from "knex";

const config: Knex.Config = {
  client: "pg",
  connection: process.env.DATABASE_URL ?? "postgresql://chaos:chaos-dev-password@localhost:5432/chaosplatform",
  migrations: {
    directory: "./src/db/migrations",
    extension: "ts",
    loadExtensions: [".ts"],
  },
};

export default config;
