import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
    validateRequestBody,
    createErrorResponse,
    createSuccessResponse,
    parseRequestBody,
} from "../utils/oneSignalClient";
import { getAPNsConfig, sendAPNsPush, APNsResponse, APNsEnvironment } from "../utils/apnsClient";

/**
 * Core function to end a live activity via APNs.
 * Can be called internally or via HTTP request.
 */
export async function endLiveActivityViaAPNsCore(
    pushToken: string,
    topic: string,
    contentState: object,
    environment: APNsEnvironment = 'production',
    context?: InvocationContext
): Promise<APNsResponse> {
    const config = getAPNsConfig();

    const payload = {
        aps: {
            timestamp: Math.floor(Date.now() / 1000),
            event: 'end',
            'dismissal-date': Math.floor(Date.now() / 1000),
            'content-state': contentState,
        },
    };

    const result = await sendAPNsPush(pushToken, topic, payload, config, environment, context);

    if (context) {
        if (result.success) {
            context.log('Successfully ended live activity via APNs');
        } else {
            context.log(`Failed to end live activity via APNs: ${result.error}`);
        }
    }

    return result;
}

export async function APNsEndLiveActivity(
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log(`APNsEndLiveActivity function processed request for url "${request.url}"`);

    try {
        const body = await parseRequestBody(request);

        const validation = validateRequestBody(body, [
            'push_token',
            'topic',
            'content_state',
        ]);
        if (!validation.isValid) {
            return createErrorResponse(400, validation.error!);
        }

        const {
            push_token: pushToken,
            topic,
            content_state: contentState,
            environment: env = 'production',
        } = body;

        const environment: APNsEnvironment = env === 'sandbox' ? 'sandbox' : 'production';

        const result = await endLiveActivityViaAPNsCore(
            pushToken,
            topic,
            contentState,
            environment,
            context
        );

        if (!result.success) {
            return createErrorResponse(result.statusCode ?? 500, result.error!, result.reason);
        }

        return createSuccessResponse({
            push_token: pushToken,
            response: result.data,
        });
    } catch (error) {
        context.log(`Error in APNsEndLiveActivity: ${error.message}`);
        return createErrorResponse(500, "Internal server error", error.message);
    }
}

app.http('APNsEndLiveActivity', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: APNsEndLiveActivity,
});
