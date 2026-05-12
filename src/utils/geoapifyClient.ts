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
 * Map country code → ordered list of OSM admin_levels that represent a city;
 * the first level with a matching feature in the response is used.
 */
const COUNTRY_CITY_ADMIN_LEVEL: Record<string, number[]> = {
    CN: [5, 6], // 5 = prefecture-level (乌鲁木齐市, 文山壮族苗族自治州),
                // 6 = county-level city / district (双河市, 博乐市) used when
                //     the prefecture-level boundary is absent (e.g. XPCC enclaves).
    TW: [4],    // 臺北市, 高雄市, etc. are admin_level=4
    JP: [4],    // 神奈川県, 東京都, etc. are admin_level=4
    VN: [4],    // Thành phố Hà Nội, TP. Hồ Chí Minh, etc. are admin_level=4
    ID: [5],    // Kabupaten Tangerang, Kota Jakarta Selatan, etc. are admin_level=5
    AU: [6],    // City of Melbourne, City of Sydney, etc. are LGAs at admin_level=6
    GB: [6],    // Dorset, Greater London, etc. are ceremonial/metropolitan counties at admin_level=6
                // (avoids fallback to England/Scotland/Wales at admin_level=4)
};

/**
 * Countries for which the `area_contains` step is skipped when no name /
 * contains / country admin_level match is found. Use for countries where the
 * device-reported area string is likely to contain a broader administrative
 * region name (e.g. CN's province name appears in address strings) which
 * would otherwise cause `area_contains` to select an over-broad boundary.
 */
const COUNTRY_SKIP_AREA_CONTAINS = new Set<string>([
    "CN", // area_contains would otherwise match the surrounding province
          // (e.g. 新疆维吾尔自治区 for 博乐市) when the prefecture/county-level
          // city boundary cannot be found by name.
]);

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
 * Per-input-city admin_level pins.
 *
 * When the (normalised) input city name matches a key, the `area_contains`
 * step is skipped; instead, the response feature whose `admin_level` equals
 * the configured value is selected (after name / contains / country matches
 * have been tried). Use this for cases where `area_contains` would otherwise
 * match an over-broad boundary (e.g. the surrounding province) because the
 * device-reported area string happens to contain the province name.
 */
const CITY_NAME_ADMIN_LEVEL_PIN: Record<string, number> = {
    // (Currently empty.) Add an entry only when neither the country-level rule
    // (COUNTRY_CITY_ADMIN_LEVEL / COUNTRY_SKIP_AREA_CONTAINS) nor the regular
    // name/contains matching can produce the right boundary for an input city.
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

/** Strip diacritics/accents and special letters for fuzzy name comparison. */
function normalize(s: string): string {
    return s.trim().toLowerCase()
        .replace(/\u0131/g, "i")    // Turkish ı
        .replace(/\u0142/g, "l")    // Polish ł
        .replace(/\u00f8/g, "o")    // Scandinavian ø
        .replace(/\u0111/g, "d")    // Vietnamese/Croatian đ
        .replace(/\u00e6/g, "ae")   // æ ligature
        .replace(/\u00df/g, "ss")   // German ß
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Pick the matching feature by name, area, category, or admin_level and return its OSM relation ID. */
function extractMatch(features: GeoapifyFeature[], city: string, area?: string, countryCode?: string): GeoapifyMatchResult | null {
    const cityNorm = normalize(city);

    // 0. Per-input admin_level pin: if configured for this input city, the
    //    area_contains step is skipped, and we instead try to find a feature
    //    at the configured admin_level. Falls through to category/fallback if
    //    no such feature exists.
    const pinnedLevel = CITY_NAME_ADMIN_LEVEL_PIN[cityNorm];

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

    // 1a. Exact name match — prefer primary name over international names
    const nameMatch =
        features.find((f) => f.properties.name != null && normalize(f.properties.name) === cityNorm) ??
        features.find((f) => featureNamesMatch(f, cityNorm));

    // 1b. Contains name match: e.g. "乌鲁木齐" in "乌鲁木齐市", "El Torno" in "Municipio El Torno"
    //     Only consider admin_level ≤ 8 to skip neighbourhoods/suburbs.
    //     Sort by admin_level ascending (broad → specific) to prefer broader boundaries.
    const containsMatch = !nameMatch ? findContainsMatch(cityNorm) : undefined;

    // 2. Country-specific admin_level override (e.g. TW cities at admin_level=4).
    //    Tries the configured levels in order and uses the first feature found.
    const cityAdminLevels = countryCode ? COUNTRY_CITY_ADMIN_LEVEL[countryCode] : undefined;
    const anyNameMatch = nameMatch ?? containsMatch;

    const countryMatch = !anyNameMatch && cityAdminLevels != null
        ? cityAdminLevels.reduce<GeoapifyFeature | undefined>((found, target) => found ?? features.find((f) => {
            const level = f.properties.datasource?.raw?.admin_level ?? 0;
            return level === target && f.properties.datasource?.raw?.osm_id != null;
        }), undefined)
        : undefined;

    // 3. Per-input admin_level pin: pick the feature at the configured admin_level.
    //    When set, this also suppresses the area_contains step below.
    const pinMatch = !anyNameMatch && !countryMatch && pinnedLevel != null
        ? features.find((f) => {
            const level = f.properties.datasource?.raw?.admin_level ?? 0;
            return level === pinnedLevel && f.properties.datasource?.raw?.osm_id != null;
        })
        : undefined;

    // 4. Area match: area name against feature names (case- and diacritic-insensitive).
    //    Uses the same filter/sort/find logic as containsMatch (admin_level > 2 && <= 8,
    //    broad → specific) so that short device-reported strings like "Ha Noi" still
    //    match feature names like "Thành phố Hà Nội".
    //    Skipped when an admin_level pin is configured for the input city, or when
    //    the country is in COUNTRY_SKIP_AREA_CONTAINS (e.g. CN — falls through to
    //    category/fallback so an over-broad province isn't selected).
    const skipAreaContains = countryCode ? COUNTRY_SKIP_AREA_CONTAINS.has(countryCode) : false;
    const areaMatch = !anyNameMatch && !countryMatch && pinnedLevel == null && !skipAreaContains && area
        ? findContainsMatch(normalize(area))
        : undefined;

    // 5. Category match
    const categoryMatch = !anyNameMatch && !areaMatch && !countryMatch && !pinMatch ? features.find((feature) => {
        const cats = feature.properties.categories;
        if (!cats) return false;
        return CITY_CATEGORIES.some((c) => cats.includes(c));
    }) : undefined;

    // 6. Fallback: most specific boundary (highest admin_level ≤ 8, skipping sub-city wards/neighborhoods)
    const fallbackMatch = !anyNameMatch && !areaMatch && !countryMatch && !pinMatch && !categoryMatch
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

    const match = anyNameMatch ?? countryMatch ?? pinMatch ?? areaMatch ?? categoryMatch ?? fallbackMatch;
    if (!match) return null;

    const matchedBy = nameMatch ? "name"
        : containsMatch ? "contains"
        : countryMatch ? "country_admin_level"
        : pinMatch ? "admin_level_pin"
        : areaMatch ? "area_contains"
        : categoryMatch ? "category"
        : "fallback";

    const props = match.properties;
    const rawOsmId = props.datasource?.raw?.osm_id;
    if (rawOsmId == null) return null;

    // Find the next broader boundary as a fallback (one admin_level up)
    const matchLevel = props.datasource?.raw?.admin_level ?? 0;
    const parent = features.find((f) => {
        const level = f.properties.datasource?.raw?.admin_level ?? 0;
        return level < matchLevel && level > 2 && f.properties.datasource?.raw?.osm_id != null;
    });
    const parentOsmId = parent?.properties.datasource?.raw?.osm_id;

    const result: GeoapifyMatchResult = {
        osmId: Math.abs(rawOsmId),
        name: props.name ?? "?",
        nameInternational: props.name_international ?? {},
        categories: props.categories ?? [],
        matchedBy,
        adminLevel: String(matchLevel || "?"),
        parentOsmId: parentOsmId ? Math.abs(parentOsmId) : undefined,
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
