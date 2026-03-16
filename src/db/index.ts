import { drizzle } from "drizzle-orm/libsql";
import { loadConfig } from "../config/index.js";
import * as schema from "./schema.js";

function createDb() {
  const cfg = loadConfig();
  return drizzle(cfg.DATABASE_URL, { schema });
}

export type Database = ReturnType<typeof createDb>;

let dbInstance: Database | null = null;

export function getDb() {
  if (dbInstance == null) {
    dbInstance = createDb();
  }

  return dbInstance;
}

export const db = new Proxy({} as Database, {
  get(_target, property) {
    const value = getDb()[property as keyof Database];
    return typeof value === "function" ? value.bind(getDb()) : value;
  },
});
