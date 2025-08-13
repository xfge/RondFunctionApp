import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

export async function StartLiveActivity(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`StartLiveActivity function processed request for url "${request.url}"`);

    try {
        // Extract required parameters from POST request body
        const body = await request.json().catch(() => ({})) as any;
        const activityId = body.activity_id;
        const userId = body.user_id;
        const eventAttributes = body.event_attributes || {};

        if (!activityId) {
            return {
                status: 400,
                body: JSON.stringify({
                    error: "activity_id parameter is required in request body"
                })
            };
        }

        if (!userId) {
            return {
                status: 400,
                body: JSON.stringify({
                    error: "user_id parameter is required in request body"
                })
            };
        }

        // Environment variables
        const appId = process.env.ONESIGNAL_APP_ID;
        const apiKey = process.env.ONESIGNAL_API_KEY;

        // OneSignal API URL - using a fixed activity_type value
        const activityType = "OneSignalWidgetAttributes"; // Fixed activity type
        const url = `https://api.onesignal.com/apps/${appId}/activities/activity/${activityType}`;

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
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const responseData = await response.json();

        if (!response.ok) {
            context.log(`OneSignal API error: ${response.status} - ${JSON.stringify(responseData)}`);
            return {
                status: response.status,
                body: JSON.stringify({
                    error: "Failed to start live activity",
                    details: responseData
                })
            };
        }

        context.log(`Successfully started live activity ${activityId} for user ${userId}`);
        
        return {
            status: 200,
            body: JSON.stringify({
                success: true,
                activity_id: activityId,
                user_id: userId,
                response: responseData
            })
        };

    } catch (error) {
        context.log(`Error in StartLiveActivity: ${error.message}`);
        return {
            status: 500,
            body: JSON.stringify({
                error: "Internal server error",
                message: error.message
            })
        };
    }
}

app.http('StartLiveActivity', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: StartLiveActivity
});
