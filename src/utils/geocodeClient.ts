import { fetchWithRetry } from "./httpUtils";

const GEOCODE_LOOKUP_URL = "https://geocode.maps.co/lookup";

/**
 * Fetch boundary GeoJSON from geocode.maps.co using an OSM relation ID.
 * Returns the parsed GeoJSON FeatureCollection or null on failure.
 */
export async function fetchOSMBoundary(osmId: number): Promise<object | null> {
    const apiKey = process.env.GEOCODE_API_KEY;
    if (!apiKey) {
        throw new Error("GEOCODE_API_KEY environment variable is not set");
    }

    const url = new URL(GEOCODE_LOOKUP_URL);
    url.searchParams.set("osm_ids", `R${osmId}`);
    url.searchParams.set("polygon_geojson", "1");
    url.searchParams.set("format", "geojson");
    url.searchParams.set("api_key", apiKey);

    const data = await fetchWithRetry(url.toString());
    if (!data) return null;

    // Validate that the response has at least one feature
    if (!data.features?.length) return null;

    return data;
}
