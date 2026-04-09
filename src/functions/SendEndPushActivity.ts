import * as df from 'durable-functions';
import { InvocationContext } from '@azure/functions';
import { endLiveActivityViaAPNsCore } from './APNsEndLiveActivity';
import { APNsEnvironment } from '../utils/apnsClient';

interface SendEndPushInput {
    updateToken: string;
    topic: string;
    contentState: object;
    environment: string;
}

const handler = async (input: SendEndPushInput, context: InvocationContext) => {
    const tokenPrefix = input.updateToken.substring(0, 8);
    context.log(`SendEndPushActivity: Started for token ${tokenPrefix}... (${input.environment})`);

    const environment: APNsEnvironment = input.environment === 'sandbox' ? 'sandbox' : 'production';

    const result = await endLiveActivityViaAPNsCore(
        input.updateToken,
        input.topic,
        input.contentState,
        environment,
        context
    );

    if (result.success) {
        context.log(`SendEndPushActivity: Successfully sent end push for token ${tokenPrefix}...`);
    } else {
        context.log(`SendEndPushActivity: Failed to send end push for token ${tokenPrefix}... - ${result.error} (${result.reason})`);
    }

    return result;
};

df.app.activity('SendEndPushActivity', { handler });
