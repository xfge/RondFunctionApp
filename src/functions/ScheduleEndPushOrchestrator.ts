import * as df from 'durable-functions';
import { OrchestrationContext, OrchestrationHandler } from 'durable-functions';

interface ScheduleEndPushInput {
    updateToken: string;
    topic: string;
    contentState: object;
    environment: string;
    dismissalDate: number; // unix timestamp in seconds
}

const orchestrator: OrchestrationHandler = function* (context: OrchestrationContext) {
    const input = context.df.getInput() as ScheduleEndPushInput;
    const tokenPrefix = input.updateToken.substring(0, 8);

    const fireAt = new Date(input.dismissalDate * 1000);
    context.log(`ScheduleEndPushOrchestrator: Started for token ${tokenPrefix}... — timer set for ${fireAt.toISOString()}`);

    yield context.df.createTimer(fireAt);

    context.log(`ScheduleEndPushOrchestrator: Timer fired for token ${tokenPrefix}... — calling SendEndPushActivity`);

    const result = yield context.df.callActivity('SendEndPushActivity', {
        updateToken: input.updateToken,
        topic: input.topic,
        contentState: input.contentState,
        environment: input.environment,
    });

    context.log(`ScheduleEndPushOrchestrator: Completed for token ${tokenPrefix}...`);

    return result;
};

df.app.orchestration('ScheduleEndPushOrchestrator', orchestrator);
