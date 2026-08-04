import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@blokjs/shared";
import { RunTracker } from "./tracing/RunTracker";
import type { BrowserArtifact } from "./tracing/types";

export type BrowserScreenshotArtifact = BrowserArtifact & { kind: "screenshot"; mimeType: "image/png" };

const safeId = (value: string): string => {
	if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid browser artifact id");
	return value;
};

export function browserArtifactFilePath(runId: string, artifactId: string): string {
	const root = resolve(process.env.BLOK_PROJECT_ROOT || process.cwd(), ".blok", "artifacts");
	return join(root, safeId(runId), `${safeId(artifactId)}.png`);
}

export async function saveBrowserScreenshot(
	ctx: Context,
	data: Uint8Array,
	name: string,
	metadata?: Record<string, unknown>,
): Promise<BrowserScreenshotArtifact> {
	if (data.byteLength > 10 * 1024 * 1024) throw new Error("Browser screenshot exceeds the 10MB artifact limit");
	const privateCtx = ctx as unknown as Record<string, unknown>;
	const runId = (privateCtx._traceRunId as string | undefined) ?? ctx.id;
	const nodeRunId = privateCtx._traceNodeId as string | undefined;
	const id = `artifact_${randomUUID().replaceAll("-", "")}`;
	const path = browserArtifactFilePath(runId, id);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, data);

	const artifact: BrowserScreenshotArtifact = {
		id,
		runId,
		nodeRunId,
		kind: "screenshot",
		name: name.slice(0, 100) || "screenshot",
		mimeType: "image/png",
		size: data.byteLength,
		createdAt: Date.now(),
		url: `/__blok/runs/${runId}/artifacts/${id}`,
		metadata,
	};
	if (nodeRunId) RunTracker.getInstance().recordNodeArtifact(nodeRunId, artifact);
	return artifact;
}
