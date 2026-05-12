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
        context.log('CityBoundary request body:', body);

        const validation = validateRequestBody(body, ['lat', 'lng', 'city']);
        if (!validation.isValid) {
            context.log(`CityBoundary 400: ${validation.error}`);
            return createErrorResponse(400, validation.error!);
        }

        const { lat, lng, city, country_code: countryCode, device_region: deviceRegion, area } = body;

        if (typeof lat !== 'number' || lat < -90 || lat > 90) {
            context.log(`CityBoundary 400: lat must be a number between -90 and 90`);
            return createErrorResponse(400, "lat must be a number between -90 and 90");
        }
        if (typeof lng !== 'number' || lng < -180 || lng > 180) {
            context.log(`CityBoundary 400: lng must be a number between -180 and 180`);
            return createErrorResponse(400, "lng must be a number between -180 and 180");
        }

        const noData = (city === "无数据" || city === "No Data");
        if (noData) {
            context.log(`CityBoundary 400: No valid city data provided`);
            return createErrorResponse(400, "No valid city data provided");
        }

        const route = resolveRoute(countryCode, deviceRegion, city);
        let osmId = route.osmId;
        let amapName = route.amapName;
        let amapFallbackName: string | undefined;
        let parentOsmId: number | undefined;

        // If no pre-resolved osmId, call Geoapify
        if (osmId == null) {
            const match = await fetchGeoapifyMatch(lat, lng, city, countryCode, area, (...args) => context.log(...args));
            if (!match) {
                context.log(`CityBoundary 404: No city boundary found for the given coordinates and city name`);
                return createErrorResponse(404, "No city boundary found for the given coordinates and city name");
            }
            osmId = match.osmId;
            parentOsmId = match.parentOsmId;
            const mismatchTag = match.matchedBy === "name" ? "" : " [MISMATCH]";
            context.log(`Geoapify resolved${mismatchTag}: "${city}" → R${osmId} "${match.name}" admin_level=${match.adminLevel} (${match.matchedBy})`);

            if (route.source === "amap") {
                amapName = match.nameInternational["zh"];
                amapFallbackName = match.name !== "?" && match.name !== amapName ? match.name : undefined;
                if (!amapName) {
                    context.log(`CityBoundary 404: No Chinese name available from Geoapify for R${osmId}`);
                    return createErrorResponse(404, `No Chinese name available from Geoapify for R${osmId}`);
                }
            }
        } else {
            context.log(`Hardcoded: ${countryCode} → R${osmId} (${route.source})`);
        }

        // Fetch boundary from the resolved source
        if (route.source === "amap") {
            if (!amapName) {
                context.log(`CityBoundary 404: No Chinese name available for R${osmId}`);
                return createErrorResponse(404, `No Chinese name available for R${osmId}`);
            }
            return await handleAmapBoundary(osmId, amapName, amapFallbackName, countryCode, context);
        }
        return await handleOSMBoundary(osmId, parentOsmId, countryCode, context);
    } catch (error) {
        context.log(`Error in CityBoundary: ${error.message}`);
        return createErrorResponse(500, "Internal server error", error.message);
    }
}

async function handleOSMBoundary(
    osmId: number,
    parentOsmId: number | undefined,
    countryCode: string | undefined,
    context: InvocationContext,
): Promise<HttpResponseInit> {
    const cc = countryCode ?? "none";
    const cached = await getOSMGeoJSON(osmId);
    if (cached) {
        context.log(`Cache hit: boundary-osm/R${osmId}.geojson (country_code=${cc})`);
        return createSuccessResponse({ source: "osm", osm_id: osmId, cached: true, geojson: cached });
    }

    let geojson = await fetchOSMBoundary(osmId);
    if (!geojson && parentOsmId) {
        context.log(`Boundary not available for R${osmId}, falling back to parent R${parentOsmId}`);
        const parentCached = await getOSMGeoJSON(parentOsmId);
        if (parentCached) {
            context.log(`Cache hit: boundary-osm/R${parentOsmId}.geojson (country_code=${cc})`);
            return createSuccessResponse({ source: "osm", osm_id: parentOsmId, cached: true, geojson: parentCached });
        }
        geojson = await fetchOSMBoundary(parentOsmId);
        if (geojson) {
            await setOSMGeoJSON(parentOsmId, geojson);
            context.log(`Fetched and cached: boundary-osm/R${parentOsmId}.geojson (fallback, country_code=${cc})`);
            return createSuccessResponse({ source: "osm", osm_id: parentOsmId, cached: false, geojson });
        }
    }
    if (!geojson) {
        context.log(`CityBoundary 404: Boundary geometry not available for OSM relation R${osmId}`);
        return createErrorResponse(404, `Boundary geometry not available for OSM relation R${osmId}`);
    }

    await setOSMGeoJSON(osmId, geojson);
    context.log(`Fetched and cached: boundary-osm/R${osmId}.geojson (country_code=${cc})`);
    return createSuccessResponse({ source: "osm", osm_id: osmId, cached: false, geojson });
}

async function handleAmapBoundary(
    osmId: number,
    chineseName: string,
    fallbackName: string | undefined,
    countryCode: string | undefined,
    context: InvocationContext,
): Promise<HttpResponseInit> {
    const cc = countryCode ?? "none";
    const cached = await getAmapGeoJSON(osmId);
    if (cached) {
        context.log(`Cache hit: boundary-amap/R${osmId}.geojson (country_code=${cc})`);
        return createSuccessResponse({ source: "amap", osm_id: osmId, cached: true, geojson: cached });
    }

    let geojson = await fetchAmapBoundary(chineseName);
    let usedName = chineseName;
    if (!geojson && fallbackName) {
        context.log(`AMap miss for "${chineseName}", retrying with fallback "${fallbackName}"`);
        geojson = await fetchAmapBoundary(fallbackName);
        usedName = fallbackName;
    }
    if (!geojson) {
        context.log(`CityBoundary 404: AMap boundary not available for "${chineseName}"${fallbackName ? ` / "${fallbackName}"` : ""} (R${osmId})`);
        return createErrorResponse(404, `AMap boundary not available for "${chineseName}" (R${osmId})`);
    }

    await setAmapGeoJSON(osmId, geojson);
    context.log(`Fetched and cached: boundary-amap/R${osmId}.geojson (searched="${usedName}", country_code=${cc})`);
    return createSuccessResponse({ source: "amap", osm_id: osmId, cached: false, geojson });
}

app.http('CityBoundary', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: CityBoundary,
});
