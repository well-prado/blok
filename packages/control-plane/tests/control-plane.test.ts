import { InMemoryInteractionStore, MemorySessionStore } from "@blokjs/runner";
import type { PolicyDecision, PolicyRequest } from "@blokjs/shared";
import {
	type CallOptions,
	type ClientUnaryCall,
	Metadata,
	type ServiceError,
	credentials,
	status,
} from "@grpc/grpc-js";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessControlPlaneClient } from "../src/ControlPlaneClient";
import { HarnessControlPlaneServer, type HarnessControlPlaneServerOptions } from "../src/ControlPlaneServer";
import { getHarnessControlPlaneClientConstructor } from "../src/proto";

const servers: HarnessControlPlaneServer[] = [];

async function start(options: HarnessControlPlaneServerOptions = {}) {
	const server = await HarnessControlPlaneServer.start(options);
	servers.push(server);
	return { server, client: new HarnessControlPlaneClient({ endpoint: server.endpoint(), defaultDeadlineMs: 2_000 }) };
}

afterEach(async () => {
	while (servers.length > 0) await servers.pop()?.stop();
});

describe("@blokjs/control-plane", () => {
	it("exposes a dedicated versioned capability surface and readiness states", async () => {
		const { server, client } = await start({ executionReady: false });
		expect(server.endpoint().address).toBe("127.0.0.1");
		expect(server.endpoint().port).toBeGreaterThan(0);
		expect(server.endpoint().token).toHaveLength(43);
		expect((await client.capabilities()).supportedVersions).toEqual(["1"]);
		expect((await client.capabilities()).operations).toContain("stream-events");
		expect((await client.health()).processAlive).toBe(true);
		expect((await client.health()).storeReady).toBe(true);
		expect((await client.readiness()).executionReady).toBe(false);
		expect((await client.readiness()).status).toBe("NOT_SERVING");
	});

	it("accepts the previous generated wire shape with omitted optional envelope fields", async () => {
		const { server } = await start();
		const Constructor = getHarnessControlPlaneClientConstructor() as unknown as new (
			address: string,
			creds: ReturnType<typeof credentials.createInsecure>,
		) => {
			createSession(
				request: { contractVersion: string; requestId: string; payloadJson: Buffer },
				metadata: Metadata,
				options: CallOptions,
				callback: (error: ServiceError | null, response?: { payloadJson: Buffer }) => void,
			): ClientUnaryCall;
			close(): void;
		};
		const raw = new Constructor(`${server.address}:${server.port}`, credentials.createInsecure());
		const metadata = new Metadata();
		metadata.set("authorization", `Bearer ${server.token}`);
		const response = await new Promise<{ payloadJson: Buffer }>((resolve, reject) => {
			raw.createSession(
				{ contractVersion: "1", requestId: "legacy-wire", payloadJson: Buffer.from("{}") },
				metadata,
				{},
				(error, value) => {
					if (error) reject(error);
					else if (value) resolve(value);
					else reject(new Error("legacy response was empty"));
				},
			);
		});
		expect(JSON.parse(response.payloadJson.toString("utf8"))).toMatchObject({ created: true });
		raw.close();
	});

	it("rejects unauthenticated local callers", async () => {
		const { server } = await start({ token: "correct-token" });
		const client = new HarnessControlPlaneClient({
			endpoint: { address: server.address, port: server.port, token: "wrong-token" },
		});
		await expect(client.health()).rejects.toMatchObject({ code: status.UNAUTHENTICATED });
		client.close();
	});

	it("creates, opens, inspects, and resumes an ordered event cursor", async () => {
		const { client } = await start();
		const created = await client.createSession({ principalId: "desktop" });
		const sessionId = created.sessionId;
		const turn = await client.submitTurn(sessionId, { content: { text: "hello" } });
		const page = [];
		for await (const event of client.streamEvents({ sessionId, afterSequence: 0, follow: false })) page.push(event);
		expect(page.map((event) => event.sequence)).toEqual([1, 2, 3]);
		expect(page.map((event) => event.kind)).toEqual(["session.created", "turn.started", "message.user"]);
		expect(page.every((event) => event.replayed)).toBe(true);

		const resumed = [];
		for await (const event of client.streamEvents({ sessionId, afterSequence: 2, follow: false })) resumed.push(event);
		expect(resumed.map((event) => event.sequence)).toEqual([3]);
		expect(resumed[0]?.replayed).toBe(true);
		expect((await client.openSession({ sessionId })).state?.activeTurnId).toBe(turn.turnId);
		expect((await client.inspectSession({ sessionId })).state?.lastSequence).toBe(3);
	});

	it("bridges turn and workflow execution into durable events", async () => {
		const { client } = await start({
			executeTurn: async () => ({ content: { text: "world" } }),
			executeWorkflow: async ({ workflowName }) => ({ output: { workflowName, ok: true } }),
		});
		const sessionId = (await client.createSession({})).sessionId;
		const turn = await client.submitTurn(sessionId, { content: "hello" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const workflow = await client.startWorkflow(sessionId, { workflowName: "demo" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		const events = [];
		for await (const event of client.streamEvents({ sessionId, follow: false })) events.push(event);
		expect(events.map((event) => event.kind)).toEqual([
			"session.created",
			"turn.started",
			"message.user",
			"message.assistant",
			"turn.completed",
			"workflow.run.started",
			"workflow.run.completed",
		]);
		expect(events.find((event) => event.turnId === turn.turnId && event.kind === "turn.completed")?.terminal).toBe(
			true,
		);
		expect(events.find((event) => event.kind === "workflow.run.completed")?.payload).toMatchObject({
			workflowRunId: workflow.workflowRunId,
		});
	});

	it("supports steering, forks, and cooperative cancellation", async () => {
		let cancelled = false;
		const { client } = await start({
			executeTurn: async ({ signal }) =>
				await new Promise<undefined>((resolve) => {
					if (signal.aborted) {
						cancelled = true;
						resolve(undefined);
						return;
					}
					signal.addEventListener(
						"abort",
						() => {
							cancelled = true;
							resolve(undefined);
						},
						{ once: true },
					);
				}),
		});
		const sessionId = (await client.createSession({})).sessionId;
		const turn = await client.submitTurn(sessionId, { content: "wait" });
		await client.steerTurn(sessionId, { turnId: turn.turnId, content: "continue" });
		await client.cancel(sessionId, { target: "turn", targetId: turn.turnId, reason: "user stopped" });
		expect(cancelled).toBe(true);
		const parent = await client.inspectSession({ sessionId });
		const fork = await client.forkSession({
			parentSessionId: sessionId,
			parentSequence: parent.state?.lastSequence ?? 0,
		});
		expect(fork.forkedFrom).toEqual({ sessionId, sequence: parent.state?.lastSequence });
		expect((await client.inspectSession({ sessionId: fork.sessionId })).state?.lineage?.parentSessionId).toBe(
			sessionId,
		);
	});

	it("answers and resumes H1-01 interactions with the authenticated principal", async () => {
		const interactionStore = new InMemoryInteractionStore();
		const { client } = await start({ interactionStore });
		const sessionId = (await client.createSession({})).sessionId;
		const request = {
			requestId: "interaction-1",
			origin: "agent",
			principal: { id: "local-client", kind: "user" },
			session: { id: sessionId },
			turn: { id: "turn-1" },
			workflow: { name: "demo" },
			step: { id: "approval" },
			manifest: null,
			scope: {
				filesystem: { read: ["."], write: [] },
				network: { hosts: [] },
				process: { commands: [] },
				secrets: [],
				fragments: {},
			},
			layers: [],
		} as unknown as PolicyRequest;
		const decision: PolicyDecision = { kind: "ask", id: "approval", reasonCode: "confirm", policyVersion: "test" };
		await interactionStore.create(request, decision);
		const answered = await client.answerInteraction(sessionId, {
			interactionId: "interaction-1",
			sequence: 0,
			answer: { ok: true },
		});
		expect(answered).toMatchObject({ interactionId: "interaction-1", status: "answered", sequence: 1 });
		const resumed = await client.resume(sessionId, { interactionId: "interaction-1", sequence: 1 });
		expect(resumed).toMatchObject({ interactionId: "interaction-1", resumed: true, sequence: 2 });
	});

	it("preserves session ownership and event order across server restart", async () => {
		const store = new MemorySessionStore();
		const first = await start({ sessionStore: store, token: "restart-token" });
		const sessionId = (await first.client.createSession({})).sessionId;
		await first.client.submitTurn(sessionId, { content: "before restart" });
		await first.server.stop();
		servers.splice(servers.indexOf(first.server), 1);
		const second = await start({
			sessionStore: store,
			token: "restart-token",
			listenAddress: `${first.server.address}:${first.server.port}`,
		});
		const events = [];
		for await (const event of second.client.streamEvents({ sessionId, afterSequence: 0, follow: false }))
			events.push(event);
		expect((await second.client.openSession({ sessionId })).state?.sessionId).toBe(sessionId);
		expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
	});
});
