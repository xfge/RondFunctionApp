import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
    createErrorResponse,
    createSuccessResponse,
    parseRequestBody,
} from "../utils/oneSignalClient";
import { CountryCodeRequest } from "../utils/boundaryTypes";
import { fetchGeoapifyCountryCode } from "../utils/geoapifyClient";

export async function CountryCode(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log(`CountryCode function processed request for url "${request.url}"`);

    try {
        const body = request.method === "POST"
            ? await parseRequestBody(request) as CountryCodeRequest
            : {};
        const coordinate = parseCoordinate(request, body);

        if (coordinate.error) {
            context.log(`CountryCode 400: ${coordinate.error}`);
            return createErrorResponse(400, coordinate.error);
        }

        const { lat, lng } = coordinate;
        const result = await fetchGeoapifyCountryCode(lat!, lng!);
        if (!result) {
            context.log(`CountryCode 404: No country found for lat=${lat} lng=${lng}`);
            return createErrorResponse(404, "No country found for the given coordinates");
        }

        context.log(`CountryCode: lat=${lat} lng=${lng} → ${result.countryCode}`);
        return createSuccessResponse({
            source: "geoapify",
            country_code: result.countryCode,
            country: result.country,
            formatted: result.formatted,
        });
    } catch (error: any) {
        const msg = error?.message ?? String(error);
        context.log(`Error in CountryCode: ${msg}`);
        context.log(`Stack: ${error?.stack}`);
        return createErrorResponse(500, "Internal server error", msg);
    }
}

interface CoordinateParseResult {
    lat?: number;
    lng?: number;
    error?: string;
}

function parseCoordinate(request: HttpRequest, body: Partial<CountryCodeRequest>): CoordinateParseResult {
    const url = new URL(request.url);
    const rawLat = body.lat ?? url.searchParams.get("lat");
    const rawLng = body.lng ?? url.searchParams.get("lng");

    if (rawLat == null) {
        return { error: "lat parameter is required" };
    }
    if (rawLng == null) {
        return { error: "lng parameter is required" };
    }

    const lat = toNumber(rawLat);
    const lng = toNumber(rawLng);

    if (lat == null || lat < -90 || lat > 90) {
        return { error: "lat must be a number between -90 and 90" };
    }
    if (lng == null || lng < -180 || lng > 180) {
        return { error: "lng must be a number between -180 and 180" };
    }

    return { lat, lng };
}

function toNumber(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

app.http("CountryCode", {
    methods: ["GET", "POST"],
    authLevel: "anonymous",
    handler: CountryCode,
});
