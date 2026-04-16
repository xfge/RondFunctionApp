/**
 * Initializes the PostgreSQL database with PostGIS and the city_boundaries table.
 * Run: npm run db:init
 */
import { readFileSync } from "fs";
import { Pool } from "pg";

// Load environment from local.settings.json
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

  console.log("Connecting to PostgreSQL...");
  const client = await pool.connect();

  try {
    console.log("Enabling PostGIS extension...");
    await client.query("CREATE EXTENSION IF NOT EXISTS postgis;");

    console.log("Creating city_boundaries table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS city_boundaries (
        id          SERIAL PRIMARY KEY,
        osm_id      BIGINT UNIQUE NOT NULL,
        name        TEXT NOT NULL,
        country_code VARCHAR(10) NOT NULL,
        admin_level INTEGER NOT NULL,
        source      VARCHAR(20) NOT NULL DEFAULT 'osm',
        geojson     JSONB NOT NULL,
        geom        GEOMETRY(Geometry, 4326),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log("Creating indexes...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_boundaries_osm_id
        ON city_boundaries (osm_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_boundaries_geom
        ON city_boundaries USING GIST (geom);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_boundaries_country_name
        ON city_boundaries (country_code, name);
    `);

    console.log("Database initialized successfully.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Init failed:", err.message);
  process.exit(1);
});
