/**
 * Convert AMap polyline string to a GeoJSON FeatureCollection.
 *
 * AMap format: "lng,lat;lng,lat;...|lng,lat;lng,lat;..."
 *   - Semicolons separate points within a ring
 *   - Pipes separate polygon rings (typically separate land masses, not holes)
 *
 * AMap coordinates are GCJ-02 — returned as-is.
 */
export function amapPolylineToGeoJSON(polyline: string, properties: Record<string, any> = {}): object {
    const rings = polyline.split("|").map(parseRing).filter((r) => r.length >= 4);

    if (rings.length === 0) {
        return { type: "FeatureCollection", features: [] };
    }

    // Each ring is treated as a separate polygon (no holes — standard for Chinese city boundaries)
    const coordinates = rings.map((ring) => [ring]);

    return {
        type: "FeatureCollection",
        features: [
            {
                type: "Feature",
                properties,
                geometry: rings.length === 1
                    ? { type: "Polygon", coordinates: [rings[0]] }
                    : { type: "MultiPolygon", coordinates },
            },
        ],
    };
}

/** Parse a single ring "lng,lat;lng,lat;..." into a GeoJSON coordinate array. */
function parseRing(ring: string): number[][] {
    const points = ring.split(";").map((pair) => {
        const [lng, lat] = pair.split(",").map(Number);
        return [lng, lat];
    });

    // Ensure the ring is closed (first point == last point)
    if (points.length >= 2) {
        const first = points[0];
        const last = points[points.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            points.push([first[0], first[1]]);
        }
    }

    return points;
}
