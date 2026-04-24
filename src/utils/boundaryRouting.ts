/** City-states with hardcoded OSM IDs and AMap Chinese names. */
const CITY_STATES: Record<string, { osmId: number; amapName?: string }> = {
    HK: { osmId: 913110, amapName: "香港特别行政区" },
    MO: { osmId: 1867188, amapName: "澳门特别行政区" },
    SG: { osmId: 536780 },
    MC: { osmId: 1124039 },
};

export interface RoutingResult {
    source: "osm" | "amap";
    /** Pre-resolved OSM ID (only for city-states; undefined means call Geoapify) */
    osmId?: number;
    /** Chinese city name for AMap lookup (only when source == "amap" and city-state) */
    amapName?: string;
}

/**
 * Determine the boundary source and any pre-resolved IDs for a given request.
 *
 * Routing rules:
 * - City-states (HK, MO, SG, MC): skip Geoapify, use hardcoded OSM IDs
 *   - HK/MO + device_region CN → AMap (China-compliant boundaries)
 *   - HK/MO + device_region other → OSM
 *   - SG/MC → always OSM
 * - country_code CN → AMap (Geoapify needed for osm_id + Chinese name)
 *   - Exception: if the city name matches a city-state's Chinese name
 *     (e.g. "香港特别行政区" / "澳门特别行政区"), the client has mislabeled
 *     HK/MO as CN. AMap cannot return these boundaries as a mainland query,
 *     so we fall back to OSM with the hardcoded city-state osmId.
 * - Everything else → OSM (Geoapify needed for osm_id)
 */
export function resolveRoute(countryCode?: string, deviceRegion?: string, city?: string): RoutingResult {
    const code = countryCode?.toUpperCase();
    const isCNRegion = deviceRegion?.toUpperCase() === "CN";

    // City-states — skip Geoapify
    const cityState = code ? CITY_STATES[code] : undefined;
    if (cityState) {
        if (isCNRegion && cityState.amapName) {
            return { source: "amap", osmId: cityState.osmId, amapName: cityState.amapName };
        }
        return { source: "osm", osmId: cityState.osmId };
    }

    // Mislabeled city-state: country_code=CN but the city name is the Chinese
    // name of a city-state (HK/MO). Route to OSM using the hardcoded osmId.
    if (code === "CN" && city) {
        for (const cs of Object.values(CITY_STATES)) {
            if (cs.amapName && cs.amapName === city) {
                return { source: "osm", osmId: cs.osmId };
            }
        }
    }

    // Regular cities
    return { source: code === "CN" ? "amap" : "osm" };
}
