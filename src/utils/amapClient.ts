import { AmapDistrictResponse } from "./boundaryTypes";
import { fetchWithRetry } from "./httpUtils";
import { amapPolylineToGeoJSON } from "./polylineToGeoJSON";

const AMAP_DISTRICT_URL = "https://restapi.amap.com/v3/config/district";

/**
 * Fetch city boundary from AMap district API using a Chinese city name.
 * Returns a GeoJSON FeatureCollection or null on failure.
 */
export async function fetchAmapBoundary(chineseCityName: string): Promise<object | null> {
    const apiKey = process.env.AMAP_API_KEY;
    if (!apiKey) {
        throw new Error("AMAP_API_KEY environment variable is not set");
    }

    const url = new URL(AMAP_DISTRICT_URL);
    url.searchParams.set("keywords", chineseCityName);
    url.searchParams.set("subdistrict", "0");
    url.searchParams.set("extensions", "all");
    url.searchParams.set("key", apiKey);

    const data = await fetchWithRetry(url.toString()) as AmapDistrictResponse | null;
    if (!data) return null;

    if (data.status !== "1" || !data.districts?.length) return null;

    const district = data.districts[0];
    if (!district.polyline) return null;

    return amapPolylineToGeoJSON(district.polyline, {
        name: district.name,
        adcode: district.adcode,
        level: district.level,
        center: district.center,
    });
}
