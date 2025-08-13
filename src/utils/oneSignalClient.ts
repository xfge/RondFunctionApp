import { InvocationContext } from "@azure/functions";

export interface OneSignalConfig {
    appId: string;
    apiKey: string;
}

export interface OneSignalResponse {
    success: boolean;
    data?: any;
    error?: string;
    details?: any;
}

export interface RequestValidationResult {
    isValid: boolean;
    error?: string;
    data?: any;
}

/**
 * Get OneSignal configuration from environment variables
 */
export function getOneSignalConfig(): OneSignalConfig {
    const appId = process.env.ONESIGNAL_APP_ID;
    const apiKey = process.env.ONESIGNAL_API_KEY;
    
    if (!appId || !apiKey) {
        throw new Error("OneSignal configuration is missing. Please set ONESIGNAL_APP_ID and ONESIGNAL_API_KEY environment variables.");
    }
    
    return { appId, apiKey };
}

/**
 * Validate required parameters from request body
 */
export function validateRequestBody(body: any, requiredFields: string[]): RequestValidationResult {
    if (!body || typeof body !== 'object') {
        return {
            isValid: false,
            error: "Invalid request body. Expected JSON object."
        };
    }

    for (const field of requiredFields) {
        if (!body[field]) {
            return {
                isValid: false,
                error: `${field} parameter is required in request body`
            };
        }
    }

    return {
        isValid: true,
        data: body
    };
}

/**
 * Make a request to OneSignal API
 */
export async function callOneSignalAPI(
    url: string,
    payload: any,
    config: OneSignalConfig,
    context: InvocationContext
): Promise<OneSignalResponse> {
    try {
        context.log(`Making OneSignal API request to: ${url}`);
        context.log(`Payload: ${JSON.stringify(payload)}`);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${config.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const responseData = await response.json();

        if (!response.ok) {
            context.log(`OneSignal API error: ${response.status} - ${JSON.stringify(responseData)}`);
            return {
                success: false,
                error: "OneSignal API request failed",
                details: responseData
            };
        }

        context.log(`OneSignal API success: ${JSON.stringify(responseData)}`);
        return {
            success: true,
            data: responseData
        };

    } catch (error) {
        context.log(`OneSignal API request failed: ${error.message}`);
        return {
            success: false,
            error: "Failed to communicate with OneSignal API",
            details: error.message
        };
    }
}

/**
 * Create a standardized error response
 */
export function createErrorResponse(status: number, error: string, details?: any) {
    return {
        status,
        body: JSON.stringify({
            error,
            ...(details && { details })
        })
    };
}

/**
 * Create a standardized success response
 */
export function createSuccessResponse(data: any) {
    return {
        status: 200,
        body: JSON.stringify({
            success: true,
            ...data
        })
    };
}

/**
 * Parse request body with error handling
 */
export async function parseRequestBody(request: any): Promise<any> {
    try {
        return await request.json();
    } catch (error) {
        return {};
    }
}
