// packages/control-plane/src/db/index.ts
// Knex database client — single instance shared across all repositories.
// Knex provides connection pooling, query building, and migration support.

import Knex from "knex";
import { logger } from "../observability/logger";

export const db = Knex({
  client: "pg",
  connection: process.env.DATABASE_URL,
  pool: {
    min: 2,
    max: 10,
    afterCreate: (conn: any, done: Function) => {
      // Set statement timeout to avoid runaway queries
      conn.query("SET statement_timeout = 30000", (err: Error) => {
        done(err, conn);
      });
    },
  },
  acquireConnectionTimeout: 10_000,
});

// Verify connection on startup
export async function checkDbConnection(): Promise<void> {
  try {
    await db.raw("SELECT 1");
    logger.info("Database connection established");
  } catch (err) {
    logger.error({ err }, "Database connection failed");
    throw err;
  }
}
