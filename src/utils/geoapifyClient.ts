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
    CN: 5, // 乌鲁木齐市, 文山壮族苗族自治州, etc. are admin_level=5
    TW: 4, // 臺北市, 高雄市, etc. are admin_level=4
    JP: 4, // 神奈川県, 東京都, etc. are admin_level=4
    VN: 4, // Thành phố Hà Nội, TP. Hồ Chí Minh, etc. are admin_level=4
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

/** Strip diacritics/accents for fuzzy name comparison (e.g. ö → o, é → e). */
function normalize(s: string): string {
    return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Pick the matching feature by name, area, category, or admin_level and return its OSM relation ID. */
function extractMatch(features: GeoapifyFeature[], city: string, area?: string, countryCode?: string): GeoapifyMatchResult | null {
    const cityNorm = normalize(city);

    /** Collect all names (primary + international) for a feature. */
    const featureNames = (feature: GeoapifyFeature): string[] => {
        const props = feature.properties;
        const names: string[] = [];
        if (props.name) names.push(props.name);
        if (props.name_international) {
            for (const v of Object.values(props.name_international)) {
                if (typeof v === "string") names.push(v);
            }
        }
        return names;
    };

    /** Check if any of a feature's names match the target exactly. */
    const featureNamesMatch = (feature: GeoapifyFeature, target: string): boolean =>
        featureNames(feature).some((n) => normalize(n) === target);

    /** Check if the target is contained in any feature name (or vice versa). */
    const featureNamesContain = (feature: GeoapifyFeature, target: string): boolean =>
        featureNames(feature).some((n) => {
            const norm = normalize(n);
            return norm.includes(target) || target.includes(norm);
        });

    /**
     * Filter features to admin_level > 2 and <= 8, sort broad → specific,
     * then return the first whose names contain the normalised target string.
     */
    const findContainsMatch = (norm: string): GeoapifyFeature | undefined =>
        [...features]
            .filter((f) => {
                const level = f.properties.datasource?.raw?.admin_level ?? 0;
                return level > 2 && level <= 8;
            })
            .sort((a, b) =>
                (a.properties.datasource?.raw?.admin_level ?? 0) -
                (b.properties.datasource?.raw?.admin_level ?? 0))
            .find((f) => featureNamesContain(f, norm));

    // 1a. Exact name match: city name against feature names (case- and diacritic-insensitive)
    const nameMatch = features.find((f) => featureNamesMatch(f, cityNorm));

    // 1b. Contains name match: e.g. "乌鲁木齐" in "乌鲁木齐市", "El Torno" in "Municipio El Torno"
    //     Only consider admin_level ≤ 8 to skip neighbourhoods/suburbs.
    //     Sort by admin_level ascending (broad → specific) to prefer broader boundaries.
    const containsMatch = !nameMatch ? findContainsMatch(cityNorm) : undefined;

    // 2. Country-specific admin_level override (e.g. TW cities at admin_level=4)
    const cityAdminLevel = countryCode ? COUNTRY_CITY_ADMIN_LEVEL[countryCode] : undefined;
    const anyNameMatch = nameMatch ?? containsMatch;

    const countryMatch = !anyNameMatch && cityAdminLevel != null
        ? features.find((f) => {
            const level = f.properties.datasource?.raw?.admin_level ?? 0;
            return level === cityAdminLevel && f.properties.datasource?.raw?.osm_id != null;
        })
        : undefined;

    // 3. Area match: area name against feature names (case- and diacritic-insensitive).
    //    Uses the same filter/sort/find logic as containsMatch (admin_level > 2 && <= 8,
    //    broad → specific) so that short device-reported strings like "Ha Noi" still
    //    match feature names like "Thành phố Hà Nội".
    const areaMatch = !anyNameMatch && !countryMatch && area
        ? findContainsMatch(normalize(area))
        : undefined;

    // 4. Category match
    const categoryMatch = !anyNameMatch && !areaMatch && !countryMatch ? features.find((feature) => {
        const cats = feature.properties.categories;
        if (!cats) return false;
        return CITY_CATEGORIES.some((c) => cats.includes(c));
    }) : undefined;

    // 5. Fallback: most specific boundary (highest admin_level ≤ 8, skipping sub-city wards/neighborhoods)
    const fallbackMatch = !anyNameMatch && !areaMatch && !countryMatch && !categoryMatch
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

    const match = anyNameMatch ?? countryMatch ?? areaMatch ?? categoryMatch ?? fallbackMatch;
    if (!match) return null;

    const matchedBy = nameMatch ? "name"
        : containsMatch ? "contains"
        : areaMatch ? "area_contains"
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
