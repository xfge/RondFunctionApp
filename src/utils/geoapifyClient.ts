import { GeoapifyResponse, GeoapifyFeature, GeoapifyMatchResult } from "./boundaryTypes";
import { fetchWithRetry } from "./httpUtils";

const GEOAPIFY_BOUNDARIES_URL = "https://api.geoapify.com/v1/boundaries/part-of";
const GEOAPIFY_REVERSE_URL = "https://api.geoapify.com/v1/geocode/reverse";
const GEOAPIFY_SEARCH_URL = "https://api.geoapify.com/v1/geocode/search";

const USE_GEOCODING = process.env.USE_GEOCODING_API === "true";

/** Geoapify category keys for city-level matching, in priority order. */
const CITY_CATEGORIES = ["administrative.county_level", "administrative.city_level"];

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
    log?: (...args: any[]) => void,
): Promise<GeoapifyMatchResult | null> {
    const apiKey = process.env.GEOAPIFY_API_KEY;
    if (!apiKey) {
        throw new Error("GEOAPIFY_API_KEY environment variable is not set");
    }

    if (USE_GEOCODING) {
        return fetchViaGeocoding(lat, lng, city, countryCode, apiKey, log);
    }
    return fetchViaBoundaries(lat, lng, city, countryCode, apiKey, log);
}

async function fetchViaBoundaries(
    lat: number,
    lng: number,
    city: string,
    countryCode: string | undefined,
    apiKey: string,
    log?: (...args: any[]) => void,
): Promise<GeoapifyMatchResult | null> {
    const url = new URL(GEOAPIFY_BOUNDARIES_URL);
    url.searchParams.set("lon", String(lng));
    url.searchParams.set("lat", String(lat));
    url.searchParams.set("geometry", "point");
    url.searchParams.set("apiKey", apiKey);

    const data = await fetchWithRetry(url.toString()) as GeoapifyResponse | null;

    const featureCount = data?.features?.length ?? 0;
    const featureDetails = (data?.features ?? []).map(f => {
        const p = f.properties;
        return `"${p.name}" geo=${f.geometry?.type ?? "?"} categories=[${p.categories?.join(", ") ?? ""}] osm_id=${p.datasource?.raw?.osm_id ?? "?"} admin_level=${p.datasource?.raw?.admin_level ?? "?"}`;
    });
    log?.(`Geoapify boundaries: lat=${lat} lng=${lng} city="${city}" countryCode=${countryCode ?? "none"} | ${featureCount} features: [${featureDetails.join(" | ")}]`);

    if (!featureCount) return null;

    return extractMatch(data!.features, city);
}

async function fetchViaGeocoding(
    lat: number,
    lng: number,
    city: string,
    countryCode: string | undefined,
    apiKey: string,
    log?: (...args: any[]) => void,
): Promise<GeoapifyMatchResult | null> {
    // Step 1: Reverse geocode to resolve city name from coordinates (1 credit)
    const reverseUrl = new URL(GEOAPIFY_REVERSE_URL);
    reverseUrl.searchParams.set("lat", String(lat));
    reverseUrl.searchParams.set("lon", String(lng));
    reverseUrl.searchParams.set("apiKey", apiKey);

    const reverseData = await fetchWithRetry(reverseUrl.toString()) as any;
    const reverseProps = reverseData?.features?.[0]?.properties;
    const resolvedCity = reverseProps?.city || reverseProps?.county || city;

    log?.(`Geoapify reverse: lat=${lat} lng=${lng} → city="${reverseProps?.city}" county="${reverseProps?.county}" state="${reverseProps?.state}"`);

    // Step 2: Search for the city to get place_id and international names (1 credit)
    const searchUrl = new URL(GEOAPIFY_SEARCH_URL);
    searchUrl.searchParams.set("text", resolvedCity);
    searchUrl.searchParams.set("type", "city");
    if (countryCode) {
        searchUrl.searchParams.set("filter", `countrycode:${countryCode.toLowerCase()}`);
    }
    searchUrl.searchParams.set("bias", `proximity:${lng},${lat}`);
    searchUrl.searchParams.set("limit", "1");
    searchUrl.searchParams.set("apiKey", apiKey);

    const searchData = await fetchWithRetry(searchUrl.toString()) as any;
    const searchProps = searchData?.features?.[0]?.properties;
    if (!searchProps) {
        log?.(`Geoapify search: no result for "${resolvedCity}"`);
        return null;
    }

    const osmId = parseOsmIdFromPlaceId(searchProps.place_id);
    if (osmId == null) {
        log?.(`Geoapify search: could not extract OSM relation ID from place_id for "${resolvedCity}", falling back to boundaries API`);
        return fetchViaBoundaries(lat, lng, city, countryCode, apiKey, log);
    }

    // Convert other_names (name:xx format) to name_international (xx format)
    const nameInternational: Record<string, string> = {};
    if (searchProps.other_names) {
        for (const [key, value] of Object.entries(searchProps.other_names)) {
            const m = key.match(/^name:([a-z]{2,3})$/);
            if (m && typeof value === "string") {
                nameInternational[m[1]] = value;
            }
        }
    }

    log?.(`Geoapify search: "${resolvedCity}" → osm_id=${osmId} name="${searchProps.name}" zh="${nameInternational["zh"] ?? "none"}"`);

    return {
        osmId,
        name: searchProps.name || resolvedCity || "?",
        nameInternational,
        categories: searchProps.category ? ["administrative", searchProps.category] : [],
        matchedBy: "name",
        adminLevel: "?",
    };
}

/**
 * Extract OSM relation ID from Geoapify place_id.
 * The place_id is a protobuf-encoded hex string containing:
 *   - Coordinates (IEEE 754 doubles, LE)
 *   - OSM type marker "f001" + 01(relation)/02(way)/03(node) — sometimes absent
 *   - OSM ID field "f901" + 8-byte little-endian integer
 *   - Name field "9203" + length-prefixed UTF-8 string
 * Only accepts relation types (f00101). Nodes/ways are rejected as they
 * cannot provide boundary geometry (e.g. Dubai returns a node).
 */
function parseOsmIdFromPlaceId(placeId: string | undefined): number | null {
    if (!placeId) return null;

    // Only accept OSM relations (f00101); reject ways (f00102) and nodes (f00103)
    const marker = "f00101f901";
    const idx = placeId.indexOf(marker);
    if (idx === -1) return null;

    const hexBytes = placeId.substring(idx + marker.length, idx + marker.length + 16);
    if (hexBytes.length < 16) return null;
    const bytes = hexBytes.match(/.{2}/g)!;
    let id = 0;
    for (let i = bytes.length - 1; i >= 0; i--) {
        id = id * 256 + parseInt(bytes[i], 16);
    }
    return id || null;
}

/** Pick the matching feature by name or category and return its OSM relation ID. */
function extractMatch(features: GeoapifyFeature[], city: string): GeoapifyMatchResult | null {
    // Primary: match by name (local + all international names)
    const nameMatch = features.find((feature) => {
        const props = feature.properties;
        const names: string[] = [];
        if (props.name) names.push(props.name);
        if (props.name_international) {
            names.push(...Object.values(props.name_international));
        }
        return names.includes(city);
    });

    const matchedBy = nameMatch ? "name" : "category";

    // Fallback: match by category
    const match = nameMatch ?? features.find((feature) => {
        const cats = feature.properties.categories;
        if (!cats) return false;
        return CITY_CATEGORIES.some((c) => cats.includes(c));
    });

    if (!match) return null;

    const props = match.properties;
    const osmId = props.datasource?.raw?.osm_id;
    if (osmId == null) return null;

    return {
        osmId: Math.abs(osmId),
        name: props.name ?? "?",
        nameInternational: props.name_international ?? {},
        categories: props.categories ?? [],
        matchedBy: matchedBy as 'name' | 'category',
        adminLevel: String(props.datasource?.raw?.admin_level ?? "?"),
    };
}
