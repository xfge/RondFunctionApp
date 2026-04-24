import { inspect } from "util";
import { GeoapifyResponse, GeoapifyFeature, GeoapifyMatchResult } from "./boundaryTypes";
import { fetchWithRetry } from "./httpUtils";

const GEOAPIFY_BOUNDARIES_URL = "https://api.geoapify.com/v1/boundaries/part-of";

/** Geoapify category keys for city-level matching, in priority order. */
const CITY_CATEGORIES = ["administrative.county_level", "administrative.city_level"];

/**
 * Country-specific city admin_level overrides.
 * Geoapify sometimes categorises cities under unexpected categories
 * (e.g. Taiwan cities are "country_part_level" instead of "city_level").
 * Map country code → the OSM admin_level that represents a city.
 */
const COUNTRY_CITY_ADMIN_LEVEL: Record<string, number> = {
    TW: 4, // 臺北市, 高雄市, etc. are admin_level=4
    JP: 4, // 神奈川県, 東京都, etc. are admin_level=4
};

/**
 * Post-Geoapify OSM ID remaps.
 *
 * Geoapify matches still run as usual; if the resolved OSM relation ID appears
 * here, it is replaced with the mapped ID. Use this when Geoapify consistently
 * returns a boundary that is too broad/narrow for our use case and we want a
 * different pre-existing OSM relation instead.
 *
 * Keys and values are absolute (unsigned) OSM relation IDs.
 */
const OSM_ID_REMAP: Record<number, { osmId: number; label: string }> = {
    // 東京都 (Tokyo Metropolis prefecture) → 東京都区部 / 東京23区 (Tokyo 23 Special Wards)
    1543125: { osmId: 19631009, label: "Tokyo 23 Wards" },
};

/**
 * Resolve coordinates + city name to an OSM relation ID and city metadata.
 * City-states (HK, MO, SG, MC) should be handled by the caller before calling this.
 * Returns null if no matching feature is found.
 */
export async function fetchGeoapifyMatch(
    lat: number,
    lng: number,
    city: string,
    countryCode?: string,
    area?: string,
    log?: (...args: any[]) => void,
): Promise<GeoapifyMatchResult | null> {
    const apiKey = process.env.GEOAPIFY_API_KEY;
    if (!apiKey) {
        throw new Error("GEOAPIFY_API_KEY environment variable is not set");
    }

    const url = new URL(GEOAPIFY_BOUNDARIES_URL);
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("geometry", "point");
    url.searchParams.set("apiKey", apiKey);

    const data = await fetchWithRetry(url.toString()) as GeoapifyResponse | null;

    const features = data?.features ?? [];
    log?.('Geoapify response:', inspect({
        features: features.map((f) => ({
            name: f.properties.name,
            categories: f.properties.categories,
            admin_level: f.properties.datasource?.raw?.admin_level,
            osm_id: f.properties.datasource?.raw?.osm_id,
        })),
    }, { depth: null, maxArrayLength: null, breakLength: Infinity }));

    if (!features.length) return null;

    return extractMatch(data!.features, city, area, countryCode);
}

/** Pick the matching feature by name, area, category, or admin_level and return its OSM relation ID. */
function extractMatch(features: GeoapifyFeature[], city: string, area?: string, countryCode?: string): GeoapifyMatchResult | null {
    const cityLower = city.toLowerCase();

    /** Check if any of a feature's names match the given target (case-insensitive). */
    const featureNamesMatch = (feature: GeoapifyFeature, target: string): boolean => {
        const props = feature.properties;
        const names: string[] = [];
        if (props.name) names.push(props.name);
        if (props.name_international) {
            for (const v of Object.values(props.name_international)) {
                if (typeof v === "string") names.push(v);
            }
        }
        return names.some((n) => n.toLowerCase() === target);
    };

    // 1. Name match: city name against feature names (case-insensitive)
    const nameMatch = features.find((f) => featureNamesMatch(f, cityLower));

    // 2. Country-specific admin_level override (e.g. TW cities at admin_level=4)
    const cityAdminLevel = countryCode ? COUNTRY_CITY_ADMIN_LEVEL[countryCode] : undefined;
    const countryMatch = !nameMatch && cityAdminLevel != null
        ? features.find((f) => {
            const level = f.properties.datasource?.raw?.admin_level ?? 0;
            return level === cityAdminLevel && f.properties.datasource?.raw?.osm_id != null;
        })
        : undefined;

    // 3. Area match: area name against feature names (case-insensitive)
    const areaMatch = !nameMatch && !countryMatch && area
        ? features.find((f) => featureNamesMatch(f, area.toLowerCase()))
        : undefined;

    // 4. Category match
    const categoryMatch = !nameMatch && !areaMatch && !countryMatch ? features.find((feature) => {
        const cats = feature.properties.categories;
        if (!cats) return false;
        return CITY_CATEGORIES.some((c) => cats.includes(c));
    }) : undefined;

    // 5. Fallback: most specific boundary (highest admin_level ≤ 8, skipping sub-city wards/neighborhoods)
    const fallbackMatch = !nameMatch && !areaMatch && !countryMatch && !categoryMatch
        ? [...features]
              .filter((f) => {
                  const level = f.properties.datasource?.raw?.admin_level ?? 0;
                  return f.properties.datasource?.raw?.osm_id != null && level <= 8;
              })
              .sort((a, b) =>
                  (b.properties.datasource?.raw?.admin_level ?? 0) -
                  (a.properties.datasource?.raw?.admin_level ?? 0))
              [0] ?? null
        : null;

    const match = nameMatch ?? countryMatch ?? areaMatch ?? categoryMatch ?? fallbackMatch;
    if (!match) return null;

    const matchedBy = nameMatch ? "name"
        : areaMatch ? "name"
        : countryMatch ? "admin_level"
        : categoryMatch ? "category"
        : "admin_level";

    const props = match.properties;
    const rawOsmId = props.datasource?.raw?.osm_id;
    if (rawOsmId == null) return null;

    const result: GeoapifyMatchResult = {
        osmId: Math.abs(rawOsmId),
        name: props.name ?? "?",
        nameInternational: props.name_international ?? {},
        categories: props.categories ?? [],
        matchedBy,
        adminLevel: String(props.datasource?.raw?.admin_level ?? "?"),
    };

    return applyOsmIdRemap(result);
}

/**
 * Apply any configured post-Geoapify OSM ID remap.
 *
 * If the result's OSM relation ID has an entry in {@link OSM_ID_REMAP}, return
 * a new result with the remapped `osmId` and `name`, and `matchedBy: "hardcoded"`
 * so the override is visible in logs. Otherwise return the result unchanged.
 */
function applyOsmIdRemap(result: GeoapifyMatchResult): GeoapifyMatchResult {
    const remap = OSM_ID_REMAP[result.osmId];
    if (!remap) return result;
    return {
        ...result,
        osmId: remap.osmId,
        name: remap.label,
        matchedBy: "hardcoded",
    };
}
