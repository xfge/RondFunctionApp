const USER_AGENT = "Rond/1.0 (Server)";

/**
 * Fetch with exponential backoff on rate limit (429/503). Max 3 retries.
 * Returns parsed JSON object or null on failure.
 */
export async function fetchWithRetry(url: string, maxRetries = 3): Promise<any | null> {
    let delay = 1000;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        let response: Response;
        try {
            response = await fetch(url, {
                headers: { "User-Agent": USER_AGENT },
            });
        } catch {
            if (attempt >= maxRetries) return null;
            await sleep(delay);
            delay *= 2;
            continue;
        }

        if (response.status === 429 || response.status === 503) {
            if (attempt >= maxRetries) return null;
            await sleep(delay);
            delay *= 2;
            continue;
        }

        if (!response.ok) return null;

        return await response.json();
    }
    return null;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
