import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
    validateRequestBody,
    createErrorResponse,
    createSuccessResponse,
    parseRequestBody,
} from "../utils/oneSignalClient";
import { getAPNsConfig, sendAPNsPush, APNsEnvironment } from "../utils/apnsClient";

export async function APNsStartLiveActivity(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    const requestId = request.headers.get('x-request-id') ?? 'unknown';
    context.log(`APNsStartLiveActivity [${requestId}] processing request`);

    try {
        const body = await parseRequestBody(request);

        const validation = validateRequestBody(body, [
            'push_token',
            'topic',
            'attributes_type',
            'attributes',
            'content_state',
        ]);
        if (!validation.isValid) {
            return createErrorResponse(400, validation.error!);
        }

        const {
            push_token: pushToken,
            topic,
            attributes_type: attributesType,
            attributes,
            content_state: contentState,
            alert,
            relevance_score: relevanceScore,
            environment: env = 'production',
        } = body;

        const environment: APNsEnvironment = env === 'sandbox' ? 'sandbox' : 'production';

        const config = getAPNsConfig();

        const payload: any = {
            aps: {
                timestamp: Math.floor(Date.now() / 1000),
                event: 'start',
                'content-state': contentState,
                'attributes-type': attributesType,
                attributes: attributes,
                ...(alert && { alert }),
                ...(relevanceScore !== undefined && { 'relevance-score': relevanceScore }),
            },
        };

        const result = await sendAPNsPush(pushToken, topic, payload, config, environment, context);

        if (!result.success) {
            return createErrorResponse(result.statusCode ?? 500, result.error!, result.reason);
        }

        context.log(`APNsStartLiveActivity [${requestId}] success`);

        return createSuccessResponse({
            push_token: pushToken,
            response: result.data,
        });
    } catch (error) {
        context.log(`APNsStartLiveActivity [${requestId}] error: ${error.message}`);
        return createErrorResponse(500, "Internal server error", error.message);
    }
}

app.http('APNsStartLiveActivity', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: APNsStartLiveActivity,
});
