import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
    validateRequestBody,
    createErrorResponse,
    createSuccessResponse,
    parseRequestBody,
} from "../utils/oneSignalClient";
import { CityBoundaryRequest } from "../utils/boundaryTypes";
import { getPool } from "../utils/pgClient";

export async function CityBoundaryDB(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log(`CityBoundaryDB function processed request for url "${request.url}"`);

    try {
        const body = await parseRequestBody(request) as CityBoundaryRequest;

        const validation = validateRequestBody(body, ['lat', 'lng', 'city']);
        if (!validation.isValid) {
            return createErrorResponse(400, validation.error!);
        }

        const { lat, lng, city, country_code: countryCode } = body;

        if (typeof lat !== 'number' || lat < -90 || lat > 90) {
            return createErrorResponse(400, "lat must be a number between -90 and 90");
        }
        if (typeof lng !== 'number' || lng < -180 || lng > 180) {
            return createErrorResponse(400, "lng must be a number between -180 and 180");
        }

        const result = await queryBoundary(lng, lat, city, countryCode ?? null);

        if (!result) {
            return createErrorResponse(404, "No matching city boundary found in database");
        }

        context.log(`CityBoundaryDB: ${city} → ${result.name} (R${result.osm_id}, level=${result.admin_level})`);

        return createSuccessResponse({
            source: "db",
            osm_id: Number(result.osm_id),
            name: result.name,
            admin_level: result.admin_level,
            geojson: result.geojson,
        });
    } catch (error: any) {
        const msg = error?.message ?? String(error);
        context.log(`Error in CityBoundaryDB: ${msg}`);
        context.log(`Stack: ${error?.stack}`);
        return createErrorResponse(500, "Internal server error", msg);
    }
}

interface BoundaryRow {
    osm_id: number;
    name: string;
    admin_level: number;
    geojson: object;
}

async function queryBoundary(
    lng: number,
    lat: number,
    city: string,
    countryCode: string | null,
): Promise<BoundaryRow | null> {
    const pool = getPool();
    const { rows } = await pool.query<BoundaryRow>(
        `SELECT osm_id, name, admin_level, geojson
         FROM city_boundaries
         WHERE ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
           AND $3 = ANY(search_names)
           AND ($4::varchar IS NULL OR country_code = $4)
         ORDER BY admin_level DESC
         LIMIT 1`,
        [lng, lat, city, countryCode]
    );
    return rows[0] ?? null;
}

app.http('CityBoundaryDB', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: CityBoundaryDB,
});
