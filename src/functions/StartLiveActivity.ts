import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { 
    getOneSignalConfig, 
    validateRequestBody, 
    callOneSignalAPI, 
    createErrorResponse, 
    createSuccessResponse,
    parseRequestBody 
} from "../utils/oneSignalClient";
import { endLiveActivityCore } from "./EndLiveActivity";

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

        const { 
            activity_id: activityId, 
            user_id: userId, 
            activity_type: activityType, 
            event_attributes: eventAttributes = {}, 
            ios_relevance_score: iosRelevanceScore,
            duration 
        } = body;

        // Get OneSignal configuration
        const config = getOneSignalConfig();

        // OneSignal API URL - using activity_type from request
        const url = `https://api.onesignal.com/apps/${config.appId}/activities/activity/${activityType}`;

        // Payload with fixed values and user-provided parameters
        const payload = {
            include_aliases: {
                onesignal_id: [userId]
            },
            event: "start",
            activity_id: activityId,
            event_attributes: eventAttributes,
            event_updates: {},
            name: "Start Live Activity",
            contents: {
                en: "Live Activity Started"
            },
            headings: {
                en: "Live Activity"
            },
            ...(iosRelevanceScore !== undefined && { ios_relevance_score: iosRelevanceScore })
        };

        // Make the request to OneSignal
        const result = await callOneSignalAPI(url, payload, config, context);

        if (!result.success) {
            return createErrorResponse(500, result.error!, result.details);
        }

        context.log(`Successfully started live activity ${activityId} for user ${userId} with activity type ${activityType}`);
        
        // If duration is provided and valid, wait 1 second then send end request
        if (duration !== undefined && duration !== null && duration > 0) {
            const arrivalTimestamp = eventAttributes?.visit?.arrival;
            
            if (arrivalTimestamp) {
                const dismissalDate = Math.floor(arrivalTimestamp + duration);
                context.log(`Waiting 1 second before ending activity ${activityId} with dismissal_date ${dismissalDate}`);
                
                // Wait 1 second synchronously
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                try {
                    context.log(`Now sending end request for activity ${activityId}`);
                    await endLiveActivityCore(activityId, dismissalDate, context);
                } catch (error) {
                    context.log(`Error in auto-ending live activity: ${error.message}`);
                }
            } else {
                context.log(`Warning: duration provided but visit.arrival not found in event_attributes`);
            }
        }
        
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
