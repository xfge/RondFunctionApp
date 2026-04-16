/**
 * Backfills multilingual names for existing city_boundaries rows.
 * Queries Overpass for all name tags, then batch-UPDATEs the DB.
 * Fast — no geometry fetching, no rate limiting needed.
 *
 * Run: npm run db:backfill-names
 */
import { readFileSync } from "fs";
import { Pool } from "pg";

const settings = JSON.parse(readFileSync("local.settings.json", "utf-8"));
for (const [key, value] of Object.entries(settings.Values as Record<string, string>)) {
  process.env[key] = value;
}

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

interface OverpassElement {
  id: number;
  tags?: Record<string, string>;
}

async function fetchNamesFromOverpass(osmIds: number[]): Promise<Map<number, Record<string, string>>> {
  // Query Overpass for name tags of specific relations
  // Process in batches to avoid query size limits
  const BATCH_SIZE = 500;
  const nameMap = new Map<number, Record<string, string>>();

  for (let i = 0; i < osmIds.length; i += BATCH_SIZE) {
    const batch = osmIds.slice(i, i + BATCH_SIZE);
    const idList = batch.join(",");

    const query = `
      [out:json][timeout:120];
      rel(id:${idList});
      out tags;
    `;

    console.log(`  Fetching names batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(osmIds.length / BATCH_SIZE)}...`);

    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      body: `data=${encodeURIComponent(query)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    if (!res.ok) {
      console.error(`  Overpass error: ${res.status}`);
      continue;
    }

    const data = await res.json();
    for (const el of data.elements as OverpassElement[]) {
      if (!el.tags) continue;

      // Extract all name:xx tags into a language map
      const names: Record<string, string> = {};
      for (const [key, value] of Object.entries(el.tags)) {
        if (key === "name") {
          names["default"] = value;
        } else if (key.startsWith("name:")) {
          const lang = key.slice(5); // "name:zh" → "zh"
          names[lang] = value;
        }
      }

      if (Object.keys(names).length > 0) {
        nameMap.set(el.id, names);
      }
    }
  }

  return nameMap;
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

  // 1. Get all osm_ids that need names or search_names
  console.log("Finding rows without names...");
  const result = await pool.query(
    "SELECT osm_id FROM city_boundaries WHERE names IS NULL OR search_names IS NULL"
  );
  const osmIds = result.rows.map((r: any) => Number(r.osm_id));

  if (osmIds.length === 0) {
    console.log("All rows already have names.");
    await pool.end();
    return;
  }
  console.log(`${osmIds.length} rows need name backfill`);

  // 2. Fetch names from Overpass
  console.log("Fetching multilingual names from Overpass...");
  const nameMap = await fetchNamesFromOverpass(osmIds);
  console.log(`Got names for ${nameMap.size} relations`);

  // 3. Batch UPDATE
  console.log("Updating database...");
  let updated = 0;
  for (const [osmId, names] of nameMap) {
    const nameLocal = names["default"] || null;
    // Build search_names: deduplicated array of all name variants
    const searchNames = [...new Set(Object.values(names))];

    await pool.query(
      `UPDATE city_boundaries
       SET names = $1, name_local = $2, search_names = $3, updated_at = NOW()
       WHERE osm_id = $4`,
      [JSON.stringify(names), nameLocal, searchNames, osmId]
    );
    updated++;
  }

  console.log(`Done. Updated ${updated} rows.`);
  await pool.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err.message);
  process.exit(1);
});
