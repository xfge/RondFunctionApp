import { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import * as df from 'durable-functions';
import {
    validateRequestBody,
    createErrorResponse,
    createSuccessResponse,
    parseRequestBody,
} from "../utils/oneSignalClient";
import { APNsEnvironment } from "../utils/apnsClient";

export async function RegisterUpdateToken(
    request: HttpRequest,
    client: df.DurableClient,
    context: InvocationContext
): Promise<HttpResponseInit> {
    context.log(`RegisterUpdateToken function processed request for url "${request.url}"`);

    try {
        const body = await parseRequestBody(request);

        const validation = validateRequestBody(body, [
            'update_token',
            'dismissal_date',
            'topic',
        ]);
        if (!validation.isValid) {
            return createErrorResponse(400, validation.error!);
        }

        const {
            update_token: updateToken,
            dismissal_date: dismissalDate,
            topic,
            content_state: contentState = {},
            environment: env = 'production',
        } = body;

        const environment: APNsEnvironment = env === 'sandbox' ? 'sandbox' : 'production';

        const now = Math.floor(Date.now() / 1000);
        const delaySeconds = dismissalDate - now;

        if (delaySeconds <= 0) {
            return createErrorResponse(400, 'dismissal_date must be in the future');
        }

        const instanceId = await client.startNew('ScheduleEndPushOrchestrator', {
            input: {
                updateToken,
                topic,
                contentState,
                environment,
                dismissalDate,
            },
        });

        context.log(`Started orchestration ${instanceId} for token ${updateToken.substring(0, 8)}... — end push in ${delaySeconds}s (at ${dismissalDate})`);

        return createSuccessResponse({
            update_token: updateToken,
            dismissal_date: dismissalDate,
            delay_seconds: delaySeconds,
            instance_id: instanceId,
        });
    } catch (error) {
        context.log(`Error in RegisterUpdateToken: ${error.message}`);
        return createErrorResponse(500, "Internal server error", error.message);
    }
}

df.app.client.http('RegisterUpdateToken', {
    route: 'RegisterUpdateToken',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: RegisterUpdateToken,
});
