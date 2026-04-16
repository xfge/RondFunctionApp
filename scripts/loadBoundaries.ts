/**
 * General-purpose boundary loader. Fetches boundary metadata from Overpass,
 * downloads GeoJSON geometry from geocode.maps.co, and inserts into PostgreSQL.
 *
 * Usage:
 *   npx tsx scripts/loadBoundaries.ts <country_code> <admin_levels>
 *
 * Examples:
 *   npx tsx scripts/loadBoundaries.ts US 4,6,8
 *   npx tsx scripts/loadBoundaries.ts JP 4,7
 *   npx tsx scripts/loadBoundaries.ts DE 4,6,8
 */
import { readFileSync } from "fs";
import { Pool } from "pg";

// ── Load env from local.settings.json ──────────────────────────────
const settings = JSON.parse(readFileSync("local.settings.json", "utf-8"));
for (const [key, value] of Object.entries(settings.Values as Record<string, string>)) {
  process.env[key] = value;
}

// ── CLI args ───────────────────────────────────────────────────────
const countryCode = process.argv[2]?.toUpperCase();
const adminLevels = process.argv[3]?.split(",").map(Number).filter((n) => !isNaN(n));

if (!countryCode || !adminLevels?.length) {
  console.error("Usage: npx tsx scripts/loadBoundaries.ts <country_code> <admin_levels>");
  console.error("Example: npx tsx scripts/loadBoundaries.ts US 4,6,8");
  process.exit(1);
}

// ── Config ─────────────────────────────────────────────────────────
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const GEOCODE_URL = "https://geocode.maps.co/lookup";
const RATE_LIMIT_MS = 1100;
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BoundaryMeta {
  osmId: number;
  name: string;
  adminLevel: number;
  names: Record<string, string> | null;
  searchNames: string[];
}

// ── Step 1: Overpass (tags only, one level at a time) ──────────────
async function fetchOneLevel(country: string, level: number): Promise<any[]> {
  const query = `
    [out:json][timeout:300];
    area["ISO3166-1"="${country}"]->.searchArea;
    rel["boundary"="administrative"]["admin_level"="${level}"](area.searchArea);
    out tags;
  `;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      body: `data=${encodeURIComponent(query)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    if (res.ok) {
      const data = await res.json();
      return data.elements ?? [];
    }

    if (attempt === 5) {
      throw new Error(`Overpass returned ${res.status} for level=${level} after 5 attempts`);
    }

    const wait = 60_000 * attempt;
    console.log(`    Overpass returned ${res.status}, retrying in ${wait / 1000}s (attempt ${attempt}/5)...`);
    await sleep(wait);
  }
  return [];
}

async function fetchBoundaryRelations(
  country: string,
  levels: number[]
): Promise<BoundaryMeta[]> {
  const allElements: any[] = [];

  // Query each level separately to avoid overloading Overpass
  for (const level of levels) {
    console.log(`  Querying admin_level=${level}...`);
    const elements = await fetchOneLevel(country, level);
    console.log(`    → ${elements.length} relations`);
    allElements.push(...elements);

    // Brief pause between queries
    if (levels.indexOf(level) < levels.length - 1) {
      await sleep(5000);
    }
  }

  console.log(`  Total: ${allElements.length} relations`);
  const elements = allElements;

  return elements.map((el) => {
    const names: Record<string, string> = {};
    const searchNames: string[] = [];

    if (el.tags) {
      for (const [key, value] of Object.entries(el.tags)) {
        if (key === "name") {
          names["default"] = value as string;
          searchNames.push(value as string);
        } else if (key.startsWith("name:")) {
          names[key.slice(5)] = value as string;
          searchNames.push(value as string);
        }
      }
    }

    return {
      osmId: el.id,
      name: el.tags?.name ?? "Unknown",
      adminLevel: parseInt(el.tags?.admin_level ?? "0"),
      names: Object.keys(names).length > 0 ? names : null,
      searchNames: [...new Set(searchNames)],
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
  const poolConfig = {
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE || "postgres",
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    port: parseInt(process.env.PG_PORT || "5432"),
    ssl: { rejectUnauthorized: false },
    idleTimeoutMillis: 0,         // don't close idle connections
    keepAlive: true,              // send TCP keepalive
    keepAliveInitialDelayMillis: 10_000,
  };
  let pool = new Pool(poolConfig);
  pool.on("error", () => {});     // prevent unhandled error crash

  // 1. Get boundary list from Overpass
  const boundaries = await fetchBoundaryRelations(countryCode, adminLevels);
  console.log(`Found ${boundaries.length} boundaries`);

  for (const level of adminLevels) {
    const count = boundaries.filter((b) => b.adminLevel === level).length;
    console.log(`  admin_level=${level}: ${count}`);
  }

  // 2. Check which are already loaded (resumable)
  const existing = await pool.query(
    "SELECT osm_id FROM city_boundaries WHERE country_code = $1 AND source = 'osm'",
    [countryCode]
  );
  const existingIds = new Set(existing.rows.map((r: any) => Number(r.osm_id)));
  const toLoad = boundaries.filter((b) => !existingIds.has(b.osmId));

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

  for (const boundary of toLoad) {
    try {
      const geojson = await fetchBoundaryGeoJSON(boundary.osmId);

      if (!geojson) {
        skipped++;
        console.log(
          `  SKIP  [${loaded + skipped + failed}/${toLoad.length}] ${boundary.name} (R${boundary.osmId}, level=${boundary.adminLevel}) — no geometry`
        );
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      const geometry = geojson.features[0].geometry;

      await pool.query(
        `INSERT INTO city_boundaries
           (osm_id, name, name_local, names, search_names, country_code, admin_level, source, geojson, geom)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'osm', $8, ST_SetSRID(ST_GeomFromGeoJSON($9), 4326))
         ON CONFLICT (osm_id, source) DO NOTHING`,
        [
          boundary.osmId,
          boundary.name,
          boundary.names?.["default"] ?? null,
          boundary.names ? JSON.stringify(boundary.names) : null,
          boundary.searchNames.length > 0 ? boundary.searchNames : null,
          countryCode,
          boundary.adminLevel,
          JSON.stringify(geojson),
          JSON.stringify(geometry),
        ]
      );

      loaded++;
      console.log(
        `  OK    [${loaded + skipped + failed}/${toLoad.length}] ${boundary.name} (R${boundary.osmId}, level=${boundary.adminLevel})`
      );
    } catch (err: any) {
      // Reconnect on connection errors and retry once
      if (err.message?.includes("Connection terminated") || err.code === "ECONNRESET") {
        console.log(`  Connection lost, reconnecting...`);
        try { await pool.end(); } catch {}
        pool = new Pool(poolConfig);
        pool.on("error", () => {});
        try {
          const geojson = await fetchBoundaryGeoJSON(boundary.osmId);
          if (geojson) {
            const geometry = geojson.features[0].geometry;
            await pool.query(
              `INSERT INTO city_boundaries
                 (osm_id, name, name_local, names, search_names, country_code, admin_level, source, geojson, geom)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'osm', $8, ST_SetSRID(ST_GeomFromGeoJSON($9), 4326))
               ON CONFLICT (osm_id, source) DO NOTHING`,
              [
                boundary.osmId, boundary.name,
                boundary.names?.["default"] ?? null,
                boundary.names ? JSON.stringify(boundary.names) : null,
                boundary.searchNames.length > 0 ? boundary.searchNames : null,
                countryCode, boundary.adminLevel,
                JSON.stringify(geojson), JSON.stringify(geojson.features[0].geometry),
              ]
            );
            loaded++;
            console.log(`  OK    [${loaded + skipped + failed}/${toLoad.length}] ${boundary.name} (R${boundary.osmId}, level=${boundary.adminLevel}) [reconnected]`);
            await sleep(RATE_LIMIT_MS);
            continue;
          }
        } catch (retryErr: any) {
          console.error(`  Retry also failed: ${retryErr.message}`);
        }
      }
      failed++;
      console.error(
        `  ERROR [${loaded + skipped + failed}/${toLoad.length}] ${boundary.name} (R${boundary.osmId}): ${err.message}`
      );
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
