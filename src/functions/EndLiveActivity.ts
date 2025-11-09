import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { 
    getOneSignalConfig, 
    validateRequestBody, 
    callOneSignalAPI, 
    createErrorResponse, 
    createSuccessResponse,
    parseRequestBody 
} from "../utils/oneSignalClient";

/**
 * Core function to end a live activity
 * Can be called internally or via HTTP request
 */
export async function endLiveActivityCore(
    activityId: string,
    dismissalDate?: number,
    context?: InvocationContext
): Promise<{ success: boolean; data?: any; error?: string }> {
    const config = getOneSignalConfig();
    const url = `https://api.onesignal.com/apps/${config.appId}/live_activities/${activityId}/notifications`;

    const payload = {
        event: "end",
        event_updates: {},
        name: "Live Activity End",
        contents: {
            en: "Live Activity Ended"
        },
        dismissal_date: dismissalDate ?? Math.floor(Date.now() / 1000),
    };

    const result = await callOneSignalAPI(url, payload, config, context);
    
    if (context) {
        if (result.success) {
            context.log(`Successfully ended live activity ${activityId}`);
        } else {
            context.log(`Failed to end live activity ${activityId}: ${result.error}`);
        }
    }
    
    return result;
}

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

        const { activity_id: activityId, dismissal_date: dismissalDate } = body;

        // Call core function
        const result = await endLiveActivityCore(activityId, dismissalDate, context);

        if (!result.success) {
            return createErrorResponse(500, result.error!, result.data);
        }
        
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
