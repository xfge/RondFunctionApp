import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { 
    getOneSignalConfig, 
    validateRequestBody, 
    callOneSignalAPI, 
    createErrorResponse, 
    createSuccessResponse,
    parseRequestBody 
} from "../utils/oneSignalClient";

export async function StartLiveActivity(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`StartLiveActivity function processed request for url "${request.url}"`);

    try {
        // Parse request body
        const body = await parseRequestBody(request);
        
        // Validate required parameters
        const validation = validateRequestBody(body, ['activity_id', 'user_id', 'activity_type']);
        if (!validation.isValid) {
            return createErrorResponse(400, validation.error!);
        }

        const { activity_id: activityId, user_id: userId, activity_type: activityType, event_attributes: eventAttributes = {} } = body;

        // Get OneSignal configuration
        const config = getOneSignalConfig();

        // OneSignal API URL - using activity_type from request
        const url = `https://api.onesignal.com/apps/${config.appId}/activities/activity/${activityType}`;

        // Payload with fixed values and user-provided parameters
        const payload = {
            include_aliases: {
                external_id: [userId]
            },
            event: "start",
            activity_id: activityId,
            event_attributes: eventAttributes,
            event_updates: {
                "timestamp": Math.floor(Date.now() / 1000)
            },
            name: "Live Activity Start",
            contents: {
                en: "Live Activity Started"
            },
            headings: {
                en: "Live Activity"
            },
        };

        // Make the request to OneSignal
        const result = await callOneSignalAPI(url, payload, config, context);

        if (!result.success) {
            return createErrorResponse(500, result.error!, result.details);
        }

        context.log(`Successfully started live activity ${activityId} for user ${userId} with activity type ${activityType}`);
        
        return createSuccessResponse({
            activity_id: activityId,
            user_id: userId,
            activity_type: activityType,
            response: result.data
        });

    } catch (error) {
        context.log(`Error in StartLiveActivity: ${error.message}`);
        return createErrorResponse(500, "Internal server error", error.message);
    }
}

app.http('StartLiveActivity', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: StartLiveActivity
});
