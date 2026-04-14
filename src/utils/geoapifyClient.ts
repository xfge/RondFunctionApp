import { GeoapifyResponse, GeoapifyFeature, GeoapifyMatchResult } from "./boundaryTypes";
import { fetchWithRetry } from "./httpUtils";

const GEOAPIFY_BOUNDARIES_URL = "https://api.geoapify.com/v1/boundaries/part-of";

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
    log?.(`Geoapify: lat=${lat} lng=${lng} city="${city}" countryCode=${countryCode ?? "none"} | ${featureCount} features: [${featureDetails.join(" | ")}]`);

    if (!featureCount) return null;

    return extractMatch(data!.features, city);
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
