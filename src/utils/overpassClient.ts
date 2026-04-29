import { inspect } from "util";
import { BoundaryMatchResult } from "./boundaryTypes";
import { fetchWithRetry } from "./httpUtils";

const OVERPASS_URL = process.env.OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";

/** Category keys for city-level matching, in priority order. */
const CITY_CATEGORIES = ["administrative.county_level", "administrative.city_level"];

/**
 * Country-specific city admin_level overrides.
 * Map country code -> the OSM admin_level that represents a city.
 */
const COUNTRY_CITY_ADMIN_LEVEL: Record<string, number> = {
    CN: 5, // 乌鲁木齐市, 文山壮族苗族自治州, etc. are admin_level=5
    TW: 4, // 臺北市, 高雄市, etc. are admin_level=4
    JP: 4, // 神奈川県, 東京都, etc. are admin_level=4
    AU: 6, // City of Melbourne, City of Sydney, etc. are LGAs at admin_level=6
};

/**
 * Post-match OSM ID remaps.
 * Keys and values are absolute (unsigned) OSM relation IDs.
 */
const OSM_ID_REMAP: Record<number, { osmId: number; label: string }> = {
    // 東京都 (Tokyo Metropolis prefecture) -> 東京都区部 / 東京23区 (Tokyo 23 Special Wards)
    1543125: { osmId: 19631009, label: "Tokyo 23 Wards" },
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface OverpassElement {
    type: string;
    id: number;
    tags: Record<string, string>;
}

interface OverpassResponse {
    elements: OverpassElement[];
}

interface BoundaryFeature {
    osmId: number;
    name: string;
    nameInternational: Record<string, string>;
    categories: string[];
    adminLevel: number;
    boundaryType: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve coordinates + city name to an OSM relation ID and city metadata
 * using the Overpass API.
 * Returns null if no matching feature is found.
 */
export async function fetchOverpassMatch(
    lat: number,
    lng: number,
    city: string,
    countryCode?: string,
    area?: string,
    log?: (...args: any[]) => void,
): Promise<BoundaryMatchResult | null> {
    const query = `[out:json][timeout:30];is_in(${lat},${lng})->.a;rel(pivot.a)["boundary"~"^(administrative|place)$"];out tags;`;

    const data = await fetchWithRetry(OVERPASS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
    }) as OverpassResponse | null;

    const elements = data?.elements ?? [];
    const features = elements
        .filter((e) => e.type === "relation" && e.tags?.name)
        .map(mapToFeature);

    log?.('Overpass response:', inspect({
        features: features.map((f) => ({
            name: f.name,
            categories: f.categories,
            admin_level: f.adminLevel || undefined,
            osm_id: f.osmId,
        })),
    }, { depth: null, maxArrayLength: null, breakLength: Infinity }));

    if (!features.length) return null;

    return extractMatch(features, city, area, countryCode);
}

// ---------------------------------------------------------------------------
// Overpass -> BoundaryFeature mapping
// ---------------------------------------------------------------------------

function mapToFeature(element: OverpassElement): BoundaryFeature {
    const tags = element.tags;
    const adminLevel = parseInt(tags.admin_level, 10) || 0;
    const boundaryType = tags.boundary ?? "administrative";

    return {
        osmId: element.id,
        name: tags.name,
        nameInternational: buildNameInternational(tags),
        categories: deriveCategories(boundaryType, adminLevel),
        adminLevel,
        boundaryType,
    };
}

/**
 * Build name_international from all name:* tags.
 * Ensures a "zh" key exists via fallback chain across Chinese variants.
 */
function buildNameInternational(tags: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(tags)) {
        if (key.startsWith("name:") && typeof value === "string" && value) {
            result[key.slice(5)] = value;
        }
    }
    // Ensure "zh" key from best available Chinese tag
    if (!result["zh"]) {
        const zhFallback = result["zh-Hans"] ?? result["zh-Hans-CN"] ?? result["zh-Hant"] ?? result["zh-Hant-TW"] ?? result["zh-Hant-HK"];
        if (zhFallback) result["zh"] = zhFallback;
    }
    return result;
}

/**
 * Derive Geoapify-style category strings from boundary type + admin_level.
 */
function deriveCategories(boundaryType: string, adminLevel: number): string[] {
    if (boundaryType === "place") {
        return ["administrative"];
    }
    const base = ["administrative"];
    if (adminLevel === 2) base.push("administrative.country_level");
    else if (adminLevel <= 4) base.push("administrative.country_part_level");
    else if (adminLevel === 5) base.push("administrative.state_level");
    else if (adminLevel === 6) base.push("administrative.county_level");
    else if (adminLevel === 7) base.push("administrative.city_level");
    else if (adminLevel >= 8) base.push("administrative.district_level");
    return base;
}

// ---------------------------------------------------------------------------
// Matching cascade
// ---------------------------------------------------------------------------

/** Strip diacritics/accents for fuzzy name comparison (e.g. o -> o, e -> e). */
function normalize(s: string): string {
    return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function extractMatch(features: BoundaryFeature[], city: string, area?: string, countryCode?: string): BoundaryMatchResult | null {
    const cityNorm = normalize(city);

    /** Collect all names (primary + international) for a feature. */
    const featureNames = (f: BoundaryFeature): string[] => {
        const names: string[] = [];
        if (f.name) names.push(f.name);
        for (const v of Object.values(f.nameInternational)) {
            if (typeof v === "string") names.push(v);
        }
        return names;
    };

    /** Check if a feature's primary name matches the target exactly. */
    const primaryNameMatch = (f: BoundaryFeature, target: string): boolean =>
        f.name ? normalize(f.name) === target : false;

    /** Exact name match (case- and diacritic-insensitive). */
    const featureNamesMatch = (f: BoundaryFeature, target: string): boolean =>
        featureNames(f).some((n) => normalize(n) === target);

    /** Contains match: target in feature name or vice versa. */
    const featureNamesContain = (f: BoundaryFeature, target: string): boolean =>
        featureNames(f).some((n) => {
            const norm = normalize(n);
            return norm.includes(target) || target.includes(norm);
        });

    // 1a. Exact name match: prefer primary name, then fall back to international names
    const nameMatch =
        features.find((f) => primaryNameMatch(f, cityNorm)) ??
        features.find((f) => featureNamesMatch(f, cityNorm));

    // 1b. Contains name match (e.g. "乌鲁木齐" in "乌鲁木齐市")
    const containsMatch = !nameMatch
        ? features.find((f) => featureNamesContain(f, cityNorm))
        : undefined;

    // 2. Country-specific admin_level override
    const cityAdminLevel = countryCode ? COUNTRY_CITY_ADMIN_LEVEL[countryCode] : undefined;
    const anyNameMatch = nameMatch ?? containsMatch;

    const countryMatch = !anyNameMatch && cityAdminLevel != null
        ? features.find((f) => f.adminLevel === cityAdminLevel && f.osmId != null)
        : undefined;

    // 3. Area match (admin_level >= 5 only, to avoid overly broad matches)
    const areaMatch = !anyNameMatch && !countryMatch && area
        ? features.find((f) =>
            f.adminLevel >= 5 &&
            featureNamesMatch(f, normalize(area)))
        : undefined;

    // 4. Category match
    const categoryMatch = !anyNameMatch && !areaMatch && !countryMatch
        ? features.find((f) => CITY_CATEGORIES.some((c) => f.categories.includes(c)))
        : undefined;

    // 5. Fallback: most specific boundary (highest admin_level <= 8)
    const fallbackMatch = !anyNameMatch && !areaMatch && !countryMatch && !categoryMatch
        ? [...features]
              .filter((f) => f.adminLevel > 0 && f.adminLevel <= 8)
              .sort((a, b) => b.adminLevel - a.adminLevel)
              [0] ?? null
        : null;

    const match = anyNameMatch ?? countryMatch ?? areaMatch ?? categoryMatch ?? fallbackMatch;
    if (!match) return null;

    const matchedBy = nameMatch ? "name"
        : containsMatch ? "contains"
        : areaMatch ? "name"
        : countryMatch ? "admin_level"
        : categoryMatch ? "category"
        : "admin_level";

    const result: BoundaryMatchResult = {
        osmId: match.osmId,
        name: match.name,
        nameInternational: match.nameInternational,
        categories: match.categories,
        matchedBy,
        adminLevel: String(match.adminLevel || "?"),
    };

    return applyOsmIdRemap(result);
}

function applyOsmIdRemap(result: BoundaryMatchResult): BoundaryMatchResult {
    const remap = OSM_ID_REMAP[result.osmId];
    if (!remap) return result;
    return {
        ...result,
        osmId: remap.osmId,
        name: remap.label,
        matchedBy: "hardcoded",
    };
}
