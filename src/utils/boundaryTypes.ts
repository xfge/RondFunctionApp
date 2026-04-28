// --- Request / Response ---

export interface CityBoundaryRequest {
    lat: number;
    lng: number;
    city: string;
    country_code?: string;
    device_region?: string;
    area?: string;
}

// --- Geoapify ---

export interface GeoapifyFeature {
    type: string;
    geometry?: {
        type?: string;
    };
    properties: {
        name?: string;
        name_international?: Record<string, string>;
        categories?: string[];
        datasource?: {
            raw?: {
                osm_id?: number;
                admin_level?: number;
            };
        };
    };
}

export interface GeoapifyResponse {
    type: string;
    features: GeoapifyFeature[];
}

export interface GeoapifyMatchResult {
    osmId: number;
    name: string;
    nameInternational: Record<string, string>;
    categories: string[];
    matchedBy: 'name' | 'contains' | 'area_contains' | 'category' | 'admin_level' | 'hardcoded';
    adminLevel: string;
}

// --- Overpass (provider-agnostic match result) ---

export interface BoundaryMatchResult {
    osmId: number;
    name: string;
    nameInternational: Record<string, string>;
    categories: string[];
    matchedBy: 'name' | 'contains' | 'area_contains' | 'category' | 'admin_level' | 'hardcoded';
    adminLevel: string;
}

// --- AMap ---

export interface AmapDistrictResponse {
    status: string;        // "1" = success
    info: string;          // "OK"
    districts: AmapDistrict[];
}

export interface AmapDistrict {
    name: string;
    adcode: string;
    citycode: string;
    level: string;         // "city", "district", "province"
    center: string;        // "lng,lat"
    polyline: string;      // "lng,lat;lng,lat;...|..." boundary rings separated by |
}
