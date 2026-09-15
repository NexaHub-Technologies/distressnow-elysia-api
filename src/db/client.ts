import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __distressnowSql: ReturnType<typeof postgres> | undefined;
}

/**
 * postgres-js + drizzle singleton.
 * The connection is lazy — importing this module never opens a socket,
 * so `/health` and tests boot without a live database.
 */
export const sql =
  globalThis.__distressnowSql ??
  postgres(env.DATABASE_URL, { max: 10, prepare: false });

if (process.env.NODE_ENV !== "production") {
  globalThis.__distressnowSql = sql;
}

export const db = drizzle(sql, { schema });

export type Database = typeof db;
