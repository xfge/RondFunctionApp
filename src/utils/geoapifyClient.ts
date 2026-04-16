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

    const featureCount = data?.features?.length ?? 0;
    const featureDetails = (data?.features ?? []).map(f => {
        const p = f.properties;
        return `"${p.name}" geo=${f.geometry?.type ?? "?"} categories=[${p.categories?.join(", ") ?? ""}] osm_id=${p.datasource?.raw?.osm_id ?? "?"} admin_level=${p.datasource?.raw?.admin_level ?? "?"}`;
    });
    log?.(`Geoapify: lat=${lat} lng=${lng} city="${city}" countryCode=${countryCode ?? "none"} | ${featureCount} features: [${featureDetails.join(" | ")}]`);

    if (!featureCount) return null;

    return extractMatch(data!.features, city, area);
}

/** Pick the matching feature by name, area, category, or admin_level and return its OSM relation ID. */
function extractMatch(features: GeoapifyFeature[], city: string, area?: string): GeoapifyMatchResult | null {
    const cityLower = city.toLowerCase();

    /** Check if any of a feature's names match the given target (case-insensitive). */
    const featureNamesMatch = (feature: GeoapifyFeature, target: string): boolean => {
        const props = feature.properties;
        const names: string[] = [];
        if (props.name) names.push(props.name);
        if (props.name_international) {
            names.push(...Object.values(props.name_international));
        }
        return names.some((n) => n.toLowerCase() === target);
    };

    // 1. Name match: city name against feature names (case-insensitive)
    const nameMatch = features.find((f) => featureNamesMatch(f, cityLower));

    // 2. Area match: area name against feature names (case-insensitive)
    const areaMatch = !nameMatch && area
        ? features.find((f) => featureNamesMatch(f, area.toLowerCase()))
        : undefined;

    // 3. Category match
    const categoryMatch = !nameMatch && !areaMatch ? features.find((feature) => {
        const cats = feature.properties.categories;
        if (!cats) return false;
        return CITY_CATEGORIES.some((c) => cats.includes(c));
    }) : undefined;

    // 4. Fallback: most specific boundary (highest admin_level ≤ 8, skipping sub-city wards/neighborhoods)
    const fallbackMatch = !nameMatch && !areaMatch && !categoryMatch
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

    const match = nameMatch ?? areaMatch ?? categoryMatch ?? fallbackMatch;
    if (!match) return null;

    const matchedBy = nameMatch ? "name"
        : areaMatch ? "name"
        : categoryMatch ? "category"
        : "admin_level";

    const props = match.properties;
    const osmId = props.datasource?.raw?.osm_id;
    if (osmId == null) return null;

    return {
        osmId: Math.abs(osmId),
        name: props.name ?? "?",
        nameInternational: props.name_international ?? {},
        categories: props.categories ?? [],
        matchedBy,
        adminLevel: String(props.datasource?.raw?.admin_level ?? "?"),
    };
}
