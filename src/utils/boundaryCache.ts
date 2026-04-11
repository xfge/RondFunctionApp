import { BlobServiceClient, ContainerClient } from "@azure/storage-blob";

const OSM_CONTAINER = "boundary-osm";
const AMAP_CONTAINER = "boundary-amap";

let osmContainer: ContainerClient | null = null;
let amapContainer: ContainerClient | null = null;

function getBlobServiceClient(): BlobServiceClient {
    const connectionString = process.env.AzureWebJobsStorage;
    if (!connectionString) {
        throw new Error("AzureWebJobsStorage environment variable is not set");
    }
    return BlobServiceClient.fromConnectionString(connectionString);
}

async function getOSMContainer(): Promise<ContainerClient> {
    if (!osmContainer) {
        const client = getBlobServiceClient();
        osmContainer = client.getContainerClient(OSM_CONTAINER);
        await osmContainer.createIfNotExists();
    }
    return osmContainer;
}

async function getAmapContainer(): Promise<ContainerClient> {
    if (!amapContainer) {
        const client = getBlobServiceClient();
        amapContainer = client.getContainerClient(AMAP_CONTAINER);
        await amapContainer.createIfNotExists();
    }
    return amapContainer;
}

function blobName(osmId: number): string {
    return `R${osmId}.geojson`;
}

// --- OSM GeoJSON ---

export async function getOSMGeoJSON(osmId: number): Promise<object | null> {
    return readBlob(await getOSMContainer(), blobName(osmId));
}

export async function setOSMGeoJSON(osmId: number, geojson: object): Promise<void> {
    await writeBlob(await getOSMContainer(), blobName(osmId), geojson);
}

// --- AMap GeoJSON ---

export async function getAmapGeoJSON(osmId: number): Promise<object | null> {
    return readBlob(await getAmapContainer(), blobName(osmId));
}

export async function setAmapGeoJSON(osmId: number, geojson: object): Promise<void> {
    await writeBlob(await getAmapContainer(), blobName(osmId), geojson);
}

// --- Internal helpers ---

async function readBlob(container: ContainerClient, name: string): Promise<object | null> {
    try {
        const blob = container.getBlockBlobClient(name);
        const response = await blob.download(0);
        const body = await streamToString(response.readableStreamBody!);
        return JSON.parse(body);
    } catch (e: any) {
        if (e.statusCode === 404) return null;
        throw e;
    }
}

async function writeBlob(container: ContainerClient, name: string, data: object): Promise<void> {
    const blob = container.getBlockBlobClient(name);
    const content = JSON.stringify(data);
    await blob.upload(content, content.length, {
        blobHTTPHeaders: { blobContentType: "application/geo+json" },
    });
}

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
}
