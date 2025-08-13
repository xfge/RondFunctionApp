import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

export async function EndLiveActivity(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`EndLiveActivity function processed request for url "${request.url}"`);

    try {
        // Extract activity_id from POST request body
        const body = await request.json().catch(() => ({})) as any;
        const activityId = body.activity_id;

        if (!activityId) {
            return {
                status: 400,
                body: JSON.stringify({
                    error: "activity_id parameter is required in request body"
                })
            };
        }

        // Environment variables
        const appId = process.env.ONESIGNAL_APP_ID;
        const apiKey = process.env.ONESIGNAL_API_KEY;

        // OneSignal API URL
        const url = `https://api.onesignal.com/apps/${appId}/live_activities/${activityId}/notifications`;

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
                    error: "Failed to end live activity",
                    details: responseData
                })
            };
        }

        context.log(`Successfully ended live activity ${activityId}`);
        
        return {
            status: 200,
            body: JSON.stringify({
                success: true,
                activity_id: activityId,
                response: responseData
            })
        };

    } catch (error) {
        context.log(`Error in EndLiveActivity: ${error.message}`);
        return {
            status: 500,
            body: JSON.stringify({
                error: "Internal server error",
                message: error.message
            })
        };
    }
}

app.http('EndLiveActivity', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: EndLiveActivity
});
