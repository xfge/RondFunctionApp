/**
 * Loads all US city boundaries (admin_level=8) into PostgreSQL.
 *
 * Flow:
 *   1. Query Overpass API for all US city boundary relation IDs + names
 *   2. Skip any already in the database (resumable)
 *   3. Fetch GeoJSON from geocode.maps.co for each
 *   4. Insert into city_boundaries table
 *
 * Run: npm run db:load-us
 */
import { readFileSync } from "fs";
import { Pool } from "pg";

// ── Load env from local.settings.json ──────────────────────────────
const settings = JSON.parse(readFileSync("local.settings.json", "utf-8"));
for (const [key, value] of Object.entries(settings.Values as Record<string, string>)) {
  process.env[key] = value;
}

// ── Config ─────────────────────────────────────────────────────────
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const GEOCODE_URL = "https://geocode.maps.co/lookup";
const RATE_LIMIT_MS = 1100; // geocode.maps.co free tier: 1 req/s
const MAX_RETRIES = 3;

// ── Helpers ────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CityMeta {
  osmId: number;
  name: string;
  names: Record<string, string> | null;
}

// ── Step 1: Overpass ───────────────────────────────────────────────
async function fetchUSCityRelations(): Promise<CityMeta[]> {
  const query = `
    [out:json][timeout:600];
    area["ISO3166-1"="US"]->.searchArea;
    rel["boundary"="administrative"]["admin_level"="8"](area.searchArea);
    out tags;
  `;

  console.log("Querying Overpass API (this may take a minute)...");
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    body: `data=${encodeURIComponent(query)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  if (!res.ok) {
    throw new Error(`Overpass API returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const elements: any[] = data.elements ?? [];

  return elements.map((el) => {
    const names: Record<string, string> = {};
    if (el.tags) {
      for (const [key, value] of Object.entries(el.tags)) {
        if (key === "name") names["default"] = value as string;
        else if (key.startsWith("name:")) names[key.slice(5)] = value as string;
      }
    }
    return {
      osmId: el.id,
      name: el.tags?.name ?? "Unknown",
      names: Object.keys(names).length > 0 ? names : null,
    };
  });
}

// ── Step 2: geocode.maps.co ────────────────────────────────────────
async function fetchBoundaryGeoJSON(osmId: number): Promise<any | null> {
  const apiKey = process.env.GEOCODE_API_KEY;
  const url = `${GEOCODE_URL}?osm_ids=R${osmId}&polygon_geojson=1&format=geojson&api_key=${apiKey}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": "Rond/1.0 (BulkLoader)" },
    });

    if (res.status === 429) {
      const wait = RATE_LIMIT_MS * attempt * 2;
      console.log(`    Rate limited, waiting ${wait}ms...`);
      await sleep(wait);
      continue;
    }

    if (!res.ok) return null;

    const data = await res.json();
    if (!data.features?.length) return null;
    return data;
  }

  return null;
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  const pool = new Pool({
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE || "postgres",
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    port: parseInt(process.env.PG_PORT || "5432"),
    ssl: { rejectUnauthorized: false },
  });

  // 1. Get city list from Overpass
  const cities = await fetchUSCityRelations();
  console.log(`Found ${cities.length} US city boundaries on Overpass`);

  // 2. Check which are already loaded (resumable)
  const existing = await pool.query(
    "SELECT osm_id FROM city_boundaries WHERE country_code = 'US'"
  );
  const existingIds = new Set(existing.rows.map((r: any) => Number(r.osm_id)));
  const toLoad = cities.filter((c) => !existingIds.has(c.osmId));

  console.log(`Already in DB: ${existingIds.size}, remaining: ${toLoad.length}`);
  if (toLoad.length === 0) {
    console.log("Nothing to load.");
    await pool.end();
    return;
  }

  const estimatedMinutes = Math.ceil((toLoad.length * RATE_LIMIT_MS) / 60_000);
  console.log(`Estimated time: ~${estimatedMinutes} minutes\n`);

  // 3. Load boundaries one by one
  let loaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const city of toLoad) {
    try {
      const geojson = await fetchBoundaryGeoJSON(city.osmId);

      if (!geojson) {
        skipped++;
        console.log(`  SKIP  [${loaded + skipped + failed}/${toLoad.length}] ${city.name} (R${city.osmId}) — no geometry`);
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      const geometry = geojson.features[0].geometry;

      await pool.query(
        `INSERT INTO city_boundaries (osm_id, name, name_local, names, country_code, admin_level, source, geojson, geom)
         VALUES ($1, $2, $3, $4, 'US', 8, 'osm', $5, ST_SetSRID(ST_GeomFromGeoJSON($6), 4326))
         ON CONFLICT (osm_id, source) DO NOTHING`,
        [city.osmId, city.name, city.names?.["default"] ?? null, city.names ? JSON.stringify(city.names) : null, JSON.stringify(geojson), JSON.stringify(geometry)]
      );

      loaded++;
      console.log(`  OK    [${loaded + skipped + failed}/${toLoad.length}] ${city.name} (R${city.osmId})`);
    } catch (err: any) {
      failed++;
      console.error(`  ERROR [${loaded + skipped + failed}/${toLoad.length}] ${city.name} (R${city.osmId}): ${err.message}`);
    }

    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\nDone. Loaded: ${loaded}, Skipped: ${skipped}, Failed: ${failed}`);
  await pool.end();
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
