import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { 
    getOneSignalConfig, 
    validateRequestBody, 
    callOneSignalAPI, 
    createErrorResponse, 
    createSuccessResponse,
    parseRequestBody 
} from "../utils/oneSignalClient";

export async function EndLiveActivity(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`EndLiveActivity function processed request for url "${request.url}"`);

    try {
        // Parse request body
        const body = await parseRequestBody(request);
        
        // Validate required parameters
        const validation = validateRequestBody(body, ['activity_id']);
        if (!validation.isValid) {
            return createErrorResponse(400, validation.error!);
        }

        const { activity_id: activityId } = body;

        // Get OneSignal configuration
        const config = getOneSignalConfig();

        // OneSignal API URL
        const url = `https://api.onesignal.com/apps/${config.appId}/live_activities/${activityId}/notifications`;

        // Default payload
        const payload = {
            event: "end",
            event_updates: {
                "timestamp": Math.floor(Date.now() / 1000)
            },
            name: "Live Activity End",
            contents: {
                en: "Live Activity Ended"
            },
            dismissal_date: Math.floor(Date.now() / 1000),
        };

        // Make the request to OneSignal
        const result = await callOneSignalAPI(url, payload, config, context);

        if (!result.success) {
            return createErrorResponse(500, result.error!, result.details);
        }

        context.log(`Successfully ended live activity ${activityId}`);
        
        return createSuccessResponse({
            activity_id: activityId,
            response: result.data
        });

    } catch (error) {
        context.log(`Error in EndLiveActivity: ${error.message}`);
        return createErrorResponse(500, "Internal server error", error.message);
    }
}

app.http('EndLiveActivity', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: EndLiveActivity
});
