import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
    validateRequestBody,
    createErrorResponse,
    createSuccessResponse,
    parseRequestBody,
} from "../utils/oneSignalClient";
import { CityBoundaryRequest } from "../utils/boundaryTypes";
import { resolveRoute } from "../utils/boundaryRouting";
import { fetchGeoapifyMatch } from "../utils/geoapifyClient";
import { fetchOSMBoundary } from "../utils/geocodeClient";
import { fetchAmapBoundary } from "../utils/amapClient";
import { getOSMGeoJSON, setOSMGeoJSON, getAmapGeoJSON, setAmapGeoJSON } from "../utils/boundaryCache";

export async function CityBoundary(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log(`CityBoundary function processed request for url "${request.url}"`);

    try {
        const body = await parseRequestBody(request) as CityBoundaryRequest;

        const validation = validateRequestBody(body, ['lat', 'lng', 'city']);
        if (!validation.isValid) {
            return createErrorResponse(400, validation.error!);
        }

        const { lat, lng, city, country_code: countryCode, device_region: deviceRegion } = body;

        if (typeof lat !== 'number' || lat < -90 || lat > 90) {
            return createErrorResponse(400, "lat must be a number between -90 and 90");
        }
        if (typeof lng !== 'number' || lng < -180 || lng > 180) {
            return createErrorResponse(400, "lng must be a number between -180 and 180");
        }

        const route = resolveRoute(countryCode, deviceRegion);
        let osmId = route.osmId;
        let amapName = route.amapName;

        // If no pre-resolved osmId, call Geoapify
        if (osmId == null) {
            const match = await fetchGeoapifyMatch(lat, lng, city, countryCode, context.log);
            if (!match) {
                return createErrorResponse(404, "No city boundary found for the given coordinates and city name");
            }
            osmId = match.osmId;
            context.log(`Geoapify resolved: ${city} → R${osmId} (${match.matchedBy})`);

            if (route.source === "amap") {
                amapName = match.nameInternational["zh"];
                if (!amapName) {
                    return createErrorResponse(404, `No Chinese name available from Geoapify for R${osmId}`);
                }
            }
        } else {
            context.log(`Hardcoded: ${countryCode} → R${osmId} (${route.source})`);
        }

        // Fetch boundary from the resolved source
        if (route.source === "amap") {
            if (!amapName) {
                return createErrorResponse(404, `No Chinese name available for R${osmId}`);
            }
            return await handleAmapBoundary(osmId, amapName, context);
        }
        return await handleOSMBoundary(osmId, context);
    } catch (error) {
        context.log(`Error in CityBoundary: ${error.message}`);
        return createErrorResponse(500, "Internal server error", error.message);
    }
}

async function handleOSMBoundary(
    osmId: number,
    context: InvocationContext,
): Promise<HttpResponseInit> {
    const cached = await getOSMGeoJSON(osmId);
    if (cached) {
        context.log(`Cache hit: boundary-osm/R${osmId}.geojson`);
        return createSuccessResponse({ source: "osm", osm_id: osmId, cached: true, geojson: cached });
    }

    const geojson = await fetchOSMBoundary(osmId);
    if (!geojson) {
        return createErrorResponse(404, `Boundary geometry not available for OSM relation R${osmId}`);
    }

    await setOSMGeoJSON(osmId, geojson);
    context.log(`Fetched and cached: boundary-osm/R${osmId}.geojson`);
    return createSuccessResponse({ source: "osm", osm_id: osmId, cached: false, geojson });
}

async function handleAmapBoundary(
    osmId: number,
    chineseName: string,
    context: InvocationContext,
): Promise<HttpResponseInit> {
    const cached = await getAmapGeoJSON(osmId);
    if (cached) {
        context.log(`Cache hit: boundary-amap/R${osmId}.geojson`);
        return createSuccessResponse({ source: "amap", osm_id: osmId, cached: true, geojson: cached });
    }

    const geojson = await fetchAmapBoundary(chineseName);
    if (!geojson) {
        return createErrorResponse(404, `AMap boundary not available for "${chineseName}" (R${osmId})`);
    }

    await setAmapGeoJSON(osmId, geojson);
    context.log(`Fetched and cached: boundary-amap/R${osmId}.geojson`);
    return createSuccessResponse({ source: "amap", osm_id: osmId, cached: false, geojson });
}

app.http('CityBoundary', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: CityBoundary,
});
