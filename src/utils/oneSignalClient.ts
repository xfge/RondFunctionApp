export interface RequestValidationResult {
    isValid: boolean;
    error?: string;
    data?: any;
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
