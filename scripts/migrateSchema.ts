/**
 * Migrates the city_boundaries table to add multilingual name columns
 * and relax the unique constraint for multi-source support.
 * Safe to run while the loader is still inserting data.
 *
 * Run: npm run db:migrate
 */
import { readFileSync } from "fs";
import { Pool } from "pg";

const settings = JSON.parse(readFileSync("local.settings.json", "utf-8"));
for (const [key, value] of Object.entries(settings.Values as Record<string, string>)) {
  process.env[key] = value;
}

async function main() {
  const pool = new Pool({
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE || "postgres",
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    port: parseInt(process.env.PG_PORT || "5432"),
    ssl: { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  try {
    console.log("Adding name_local column...");
    await client.query(`ALTER TABLE city_boundaries ADD COLUMN IF NOT EXISTS name_local TEXT`);

    console.log("Adding names (JSONB) column...");
    await client.query(`ALTER TABLE city_boundaries ADD COLUMN IF NOT EXISTS names JSONB`);

    console.log("Adding coordinate_system column...");
    await client.query(`ALTER TABLE city_boundaries ADD COLUMN IF NOT EXISTS coordinate_system VARCHAR(10) DEFAULT 'WGS84'`);

    console.log("Adding updated_at column...");
    await client.query(`ALTER TABLE city_boundaries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

    console.log("Adding search_names column...");
    await client.query(`ALTER TABLE city_boundaries ADD COLUMN IF NOT EXISTS search_names TEXT[]`);

    console.log("Creating GIN index on search_names...");
    await client.query(`CREATE INDEX IF NOT EXISTS idx_boundaries_search_names ON city_boundaries USING GIN(search_names)`);

    console.log("Updating unique constraint (osm_id, source)...");
    // Drop old constraint if it exists, add new compound one
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'city_boundaries_osm_id_key') THEN
          ALTER TABLE city_boundaries DROP CONSTRAINT city_boundaries_osm_id_key;
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'city_boundaries_osm_id_source_key') THEN
          ALTER TABLE city_boundaries ADD CONSTRAINT city_boundaries_osm_id_source_key UNIQUE(osm_id, source);
        END IF;
      END $$;
    `);

    console.log("Migration complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
