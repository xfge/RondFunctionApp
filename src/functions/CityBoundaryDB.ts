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

        const { lat, lng, city, country_code: countryCode, area } = body;

        if (typeof lat !== 'number' || lat < -90 || lat > 90) {
            return createErrorResponse(400, "lat must be a number between -90 and 90");
        }
        if (typeof lng !== 'number' || lng < -180 || lng > 180) {
            return createErrorResponse(400, "lng must be a number between -180 and 180");
        }

        const { result, matchedBy } = await queryBoundary(lng, lat, city, countryCode ?? null, area ?? null);

        if (!result) {
            context.log(`CityBoundaryDB: NO MATCH for city="${city}" area="${area ?? ""}" lat=${lat} lng=${lng} country_code=${countryCode ?? "none"}`);
            return createErrorResponse(404, `No boundary found for "${city}"${area ? ` or area "${area}"` : ""} near (${lat}, ${lng})`);
        }

        context.log(`CityBoundaryDB: ${city} → ${result.name} (R${result.osm_id}, level=${result.admin_level}, matched_by=${matchedBy})`);

        return createSuccessResponse({
            source: "db",
            osm_id: Number(result.osm_id),
            name: result.name,
            admin_level: result.admin_level,
            matched_by: matchedBy,
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

type MatchType = "exact" | "nearby" | "area";

interface QueryResult {
    result: BoundaryRow | null;
    matchedBy: MatchType | null;
}

async function queryBoundary(
    lng: number,
    lat: number,
    city: string,
    countryCode: string | null,
    area: string | null,
): Promise<QueryResult> {
    const pool = getPool();
    const point = `ST_SetSRID(ST_MakePoint($1, $2), 4326)`;

    // 1. Exact match: point inside boundary + name match
    const { rows } = await pool.query<BoundaryRow>(
        `SELECT osm_id, name, admin_level, geojson
         FROM city_boundaries
         WHERE ST_Contains(geom, ${point})
           AND $3 = ANY(search_names)
           AND ($4::varchar IS NULL OR country_code = $4)
         ORDER BY admin_level DESC
         LIMIT 1`,
        [lng, lat, city, countryCode]
    );
    if (rows[0]) return { result: rows[0], matchedBy: "exact" };

    // 2. Fallback: nearest boundary matching city name within 100km
    const { rows: nearby } = await pool.query<BoundaryRow>(
        `SELECT osm_id, name, admin_level, geojson
         FROM city_boundaries
         WHERE $3 = ANY(search_names)
           AND ($4::varchar IS NULL OR country_code = $4)
           AND ST_DWithin(geom::geography, ${point}::geography, 100000)
         ORDER BY ST_Distance(geom::geography, ${point}::geography)
         LIMIT 1`,
        [lng, lat, city, countryCode]
    );
    if (nearby[0]) return { result: nearby[0], matchedBy: "nearby" };

    // 3. Fallback: search by area name (e.g., county) if provided
    if (area) {
        const { rows: areaRows } = await pool.query<BoundaryRow>(
            `SELECT osm_id, name, admin_level, geojson
             FROM city_boundaries
             WHERE ST_Contains(geom, ${point})
               AND $3 = ANY(search_names)
               AND ($4::varchar IS NULL OR country_code = $4)
             ORDER BY admin_level DESC
             LIMIT 1`,
            [lng, lat, area, countryCode]
        );
        if (areaRows[0]) return { result: areaRows[0], matchedBy: "area" };
    }

    return { result: null, matchedBy: null };
}

app.http('CityBoundaryDB', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: CityBoundaryDB,
});
