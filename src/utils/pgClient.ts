import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.PG_HOST,
      database: process.env.PG_DATABASE || "postgres",
      user: process.env.PG_USER,
      password: process.env.PG_PASSWORD,
      port: parseInt(process.env.PG_PORT || "5432"),
      ssl: { rejectUnauthorized: false },
      max: 10,
    });
  }
  return pool;
}
