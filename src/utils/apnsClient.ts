import * as crypto from 'crypto';
import * as http2 from 'http2';
import { InvocationContext } from '@azure/functions';

export interface APNsConfig {
    keyId: string;
    teamId: string;
    privateKey: string;
}

export type APNsEnvironment = 'sandbox' | 'production';

const APNS_HOSTS: Record<APNsEnvironment, string> = {
    sandbox: 'https://api.sandbox.push.apple.com',
    production: 'https://api.push.apple.com',
};

export interface APNsResponse {
    success: boolean;
    statusCode?: number;
    data?: any;
    error?: string;
    reason?: string;
}

let cachedToken: { jwt: string; timestamp: number } | null = null;
const TOKEN_TTL = 20 * 60 * 1000; // 20 minutes

/**
 * Get APNs configuration from environment variables
 */
export function getAPNsConfig(): APNsConfig {
    const keyId = process.env.APNS_KEY_ID;
    const teamId = process.env.APNS_TEAM_ID;
    const privateKey = process.env.APNS_PRIVATE_KEY;

    if (!keyId || !teamId || !privateKey) {
        throw new Error(
            'APNs configuration is missing. Please set APNS_KEY_ID, APNS_TEAM_ID, and APNS_PRIVATE_KEY environment variables.'
        );
    }

    // The .p8 key is stored with literal \n — replace with actual newlines
    const parsedKey = privateKey.replace(/\\n/g, '\n');

    return { keyId, teamId, privateKey: parsedKey };
}

/**
 * Create a signed JWT for APNs token-based authentication (ES256).
 * Tokens are cached for 20 minutes.
 */
export function createAPNsJWT(config: APNsConfig): string {
    const now = Date.now();

    if (cachedToken && now - cachedToken.timestamp < TOKEN_TTL) {
        return cachedToken.jwt;
    }

    const header = Buffer.from(
        JSON.stringify({ alg: 'ES256', kid: config.keyId })
    ).toString('base64url');

    const iat = Math.floor(now / 1000);
    const payload = Buffer.from(
        JSON.stringify({ iss: config.teamId, iat })
    ).toString('base64url');

    const signingInput = `${header}.${payload}`;

    const key = crypto.createPrivateKey(config.privateKey);
    const signature = crypto.sign('SHA256', Buffer.from(signingInput), {
        key,
        dsaEncoding: 'ieee-p1363',
    });

    const jwt = `${signingInput}.${signature.toString('base64url')}`;
    cachedToken = { jwt, timestamp: now };

    return jwt;
}

/**
 * Send a push notification to APNs via HTTP/2
 */
export function sendAPNsPush(
    token: string,
    topic: string,
    payload: object,
    config: APNsConfig,
    environment: APNsEnvironment = 'production',
    context?: InvocationContext
): Promise<APNsResponse> {
    return new Promise((resolve) => {
        const jwt = createAPNsJWT(config);
        const host = APNS_HOSTS[environment];

        context?.log(`Using APNs ${environment} environment: ${host}`);

        const client = http2.connect(host);

        client.on('error', (err) => {
            context?.log(`APNs connection error: ${err.message}`);
            resolve({
                success: false,
                error: 'Failed to connect to APNs',
                reason: err.message,
            });
        });

        const headers: http2.OutgoingHttpHeaders = {
            ':method': 'POST',
            ':path': `/3/device/${token}`,
            'authorization': `bearer ${jwt}`,
            'apns-topic': topic,
            'apns-push-type': 'liveactivity',
            'apns-priority': '10',
        };

        context?.log(`Sending APNs push to token: ${token.substring(0, 8)}...`);
        context?.log(`APNs payload: ${JSON.stringify(payload)}`);

        const req = client.request(headers);

        let data = '';
        let responseHeaders: http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader;

        req.on('response', (hdrs) => {
            responseHeaders = hdrs;
        });

        req.on('data', (chunk) => {
            data += chunk;
        });

        req.on('end', () => {
            const statusCode = responseHeaders?.[':status'];
            client.close();

            let parsedData: any;
            try {
                parsedData = data ? JSON.parse(data) : {};
            } catch {
                parsedData = { raw: data };
            }

            if (statusCode === 200) {
                context?.log('APNs push sent successfully');
                resolve({ success: true, statusCode, data: parsedData });
            } else {
                context?.log(
                    `APNs push failed: ${statusCode} - ${JSON.stringify(parsedData)}`
                );
                resolve({
                    success: false,
                    statusCode,
                    error: 'APNs request failed',
                    reason: parsedData?.reason,
                });
            }
        });

        req.on('error', (err) => {
            client.close();
            context?.log(`APNs request error: ${err.message}`);
            resolve({
                success: false,
                error: 'APNs request failed',
                reason: err.message,
            });
        });

        req.write(JSON.stringify(payload));
        req.end();
    });
}
