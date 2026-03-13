import { drizzle } from "drizzle-orm/libsql";
import { loadConfig } from "../config/index.js";
import * as schema from "./schema.js";

const cfg = loadConfig();

export const db = drizzle(cfg.DATABASE_URL, { schema });
