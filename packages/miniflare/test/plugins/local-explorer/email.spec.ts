import { Miniflare } from "miniflare";
import PostalMime from "postal-mime";
import dedent from "ts-dedent";
import {
	afterAll,
	beforeAll,
	describe,
	type ExpectStatic,
	test,
	vi,
} from "vitest";
import { CorePaths } from "../../../src/workers/core/constants";
import {
	zEmailDeleteActivityResponse,
	zEmailGetMessageResponse,
	zEmailListRoutingActivityResponse,
	zEmailListSendingActivityResponse,
	zEmailSendTestResponse,
} from "../../../src/workers/local-explorer/generated/zod.gen";
import { disposeWithRetry } from "../../test-shared";
import { expectValidResponse } from "./helpers";

const BASE_URL = `http://localhost${CorePaths.EXPLORER}/api`;

// A routing Worker whose `email()` handler branches on the recipient so a
// single instance can exercise every disposition (forward / reply / reject /
// throw / drop).
const ROUTING_WORKER = dedent /* javascript */ `
	import { EmailMessage } from "cloudflare:email";

	export default {
		fetch() { return new Response("ok"); },
		async email(message) {
			if (message.to === "forward@example.com") {
				await message.forward("dest@example.com");
			} else if (message.to === "reply@example.com") {
				const originalMessageId = message.headers.get("Message-ID");
				const raw = [
					"From: " + message.to,
					"To: " + message.from,
					"Subject: Re: hello",
					"Message-ID: <reply-" + Date.now() + "@example.com>",
					"In-Reply-To: " + originalMessageId,
					"References: " + originalMessageId,
					"MIME-Version: 1.0",
					"Content-Type: text/plain",
					"",
					"a reply body",
				].join("\\r\\n");
				await message.reply(
					new EmailMessage(message.to, message.from, raw)
				);
			} else if (message.to === "throw@example.com") {
				throw new Error("handler boom");
			}
			// otherwise: consume (drop)
		},
	};
`;

// A sending Worker that dispatches whatever JSON MessageBuilder it receives via
// its `send_email` binding.
const SENDING_WORKER = dedent /* javascript */ `
	export default {
		async fetch(request, env) {
			const builder = await request.json();
			await env.SEND_EMAIL.send(builder);
			return new Response("ok");
		},
	};
`;

function incomingEmail(to: string): string {
	return dedent`
		From: someone <someone@example.com>
		To: recipient <${to}>
		Message-ID: <routing-${to}@example.com>
		Subject: hello
		MIME-Version: 1.0
		Content-Type: text/plain

		This is the incoming body.`;
}

async function triggerRouting(mf: Miniflare, to: string): Promise<void> {
	const response = await mf.dispatchFetch(
		"http://localhost/cdn-cgi/handler/email?" +
			new URLSearchParams({ from: "someone@example.com", to }).toString(),
		{ body: incomingEmail(to), method: "POST" }
	);
	// `dispatchFetch` requires the body be consumed immediately.
	await response.text();
}

/**
 * Activity is persisted from a `ctx.waitUntil()` callback, so it may not be
 * durable by the time `dispatchFetch` resolves. Poll the list endpoint until
 * the predicate is satisfied.
 */
async function waitForRoutingRecords(
	mf: Miniflare,
	worker: string,
	predicate: (
		records: Array<{
			messageId?: string;
			status: string;
			action: string;
			to: string;
		}>
	) => boolean,
	expect: ExpectStatic
) {
	return vi.waitFor(
		async () => {
			const response = await mf.dispatchFetch(
				`${BASE_URL}/email/${worker}/routing`
			);
			const data = await expectValidResponse(
				response,
				zEmailListRoutingActivityResponse,
				expect
			);
			const records = data.result ?? [];
			if (!predicate(records)) {
				throw new Error(
					`Predicate not satisfied for:\n${JSON.stringify(records, null, 2)}`
				);
			}
			return records;
		},
		{ timeout: 5_000, interval: 100 }
	);
}

describe("Email API — routing", () => {
	const worker = "routing-worker";
	let mf: Miniflare;

	beforeAll(async () => {
		mf = new Miniflare({
			name: worker,
			inspectorPort: 0,
			compatibilityDate: "2025-03-17",
			modules: true,
			script: ROUTING_WORKER,
			unsafeTriggerHandlers: true,
			unsafeLocalExplorer: true,
		});
	});

	afterAll(async () => {
		await disposeWithRetry(mf);
	});

	test("records a worker row and a delivered forward row", async ({
		expect,
	}) => {
		await triggerRouting(mf, "forward@example.com");

		const marker = "routing-forward@example.com";
		const records = await waitForRoutingRecords(
			mf,
			worker,
			(r) =>
				r.some((e) => e.action === "worker" && e.messageId?.includes(marker)) &&
				r.some(
					(e) =>
						e.action === "unknown" &&
						e.status === "delivered" &&
						e.messageId?.includes(marker)
				),
			expect
		);

		const workerRow = records.find(
			(e) => e.action === "worker" && e.messageId?.includes(marker)
		);
		const forwardRow = records.find(
			(e) => e.action === "unknown" && e.messageId?.includes(marker)
		);
		expect(workerRow).toBeDefined();
		expect(workerRow?.status).toBe("dropped");
		expect(forwardRow).toBeDefined();
		expect(forwardRow?.status).toBe("delivered");
		// The forward row keeps the original incoming recipient as its `to`
		// (the forward destination lives only in the console log), so every
		// lifecycle row for this message shares the same `to`.
		expect(forwardRow?.to).toBe("forward@example.com");
		// The forward is the terminal event for this message id.
		expect(forwardRow?.isLastEvent).toBe(1);
	});

	// NOTE: `message.setReject()` is dispatched as a fire-and-forget JSRPC call
	// to the host, so the rejection reason is not guaranteed to be observed
	// before the handler returns and activity is recorded. The `deliveryFailed`
	// status therefore can't be asserted deterministically in local dev, so it
	// is intentionally left uncovered here.

	test("records an error worker row when the handler throws", async ({
		expect,
	}) => {
		await triggerRouting(mf, "throw@example.com");

		const marker = "routing-throw@example.com";
		const records = await waitForRoutingRecords(
			mf,
			worker,
			(r) =>
				r.some((e) => e.messageId?.includes(marker) && e.status === "error"),
			expect
		);
		const row = records.find((e) => e.messageId?.includes(marker));
		expect(row?.status).toBe("error");
		expect(row?.errorDetail).toContain("handler boom");
	});

	test("records a delivered reply row with a new message id", async ({
		expect,
	}) => {
		await triggerRouting(mf, "reply@example.com");

		const marker = "routing-reply@example.com";
		const records = await waitForRoutingRecords(
			mf,
			worker,
			(r) =>
				r.some((e) => e.action === "worker" && e.messageId?.includes(marker)) &&
				r.some(
					(e) =>
						e.status === "delivered" &&
						e.action === "unknown" &&
						e.to === "someone@example.com" &&
						!e.messageId?.includes(marker)
				),
			expect
		);
		const workerRow = records.find(
			(e) => e.action === "worker" && e.messageId?.includes(marker)
		);
		const replyRow = records.find(
			(e) =>
				e.status === "delivered" &&
				e.action === "unknown" &&
				e.to === "someone@example.com" &&
				!e.messageId?.includes(marker)
		);
		expect(workerRow?.action).toBe("worker");
		// A reply is a brand new outbound message, so it must have its own id.
		expect(replyRow).toBeDefined();
		expect(replyRow?.messageId).not.toContain(marker);

		// The reply's stored raw must be retrievable and parse to its text body.
		const rawResponse = await mf.dispatchFetch(
			`${BASE_URL}/email/${worker}/raw?` +
				new URLSearchParams({
					messageId: String(replyRow?.messageId),
				}).toString()
		);
		expect(rawResponse.status).toBe(200);
		const email = await PostalMime.parse(await rawResponse.text());
		expect(email.text?.trim()).toBe("a reply body");
	});

	test("exposes a single record and its raw email, 404s for unknown raw", async ({
		expect,
	}) => {
		await triggerRouting(mf, "forward@example.com");
		const records = await waitForRoutingRecords(
			mf,
			worker,
			(r) => r.some((e) => e.action === "worker"),
			expect
		);
		const workerRow = records.find((e) => e.action === "worker");
		expect(workerRow).toBeDefined();

		const messageResponse = await mf.dispatchFetch(
			`${BASE_URL}/email/${worker}/messages/${workerRow?.id}`
		);
		const message = await expectValidResponse(
			messageResponse,
			zEmailGetMessageResponse,
			expect
		);
		expect(message.result?.id).toBe(workerRow?.id);

		// The worker row stored the incoming raw, so it should be retrievable.
		const rawResponse = await mf.dispatchFetch(
			`${BASE_URL}/email/${worker}/raw?` +
				new URLSearchParams({
					messageId: String(workerRow?.messageId),
				}).toString()
		);
		expect(rawResponse.status).toBe(200);
		expect(await rawResponse.text()).toContain("This is the incoming body.");

		const missingRaw = await mf.dispatchFetch(
			`${BASE_URL}/email/${worker}/raw?` +
				new URLSearchParams({ messageId: "<does-not-exist@example.com>" })
		);
		expect(missingRaw.status).toBe(404);
		await missingRaw.text();
	});

	test("clears activity on DELETE", async ({ expect }) => {
		await triggerRouting(mf, "forward@example.com");
		await waitForRoutingRecords(mf, worker, (r) => r.length > 0, expect);

		const deleteResponse = await mf.dispatchFetch(
			`${BASE_URL}/email/${worker}`,
			{ method: "DELETE" }
		);
		const deleted = await expectValidResponse(
			deleteResponse,
			zEmailDeleteActivityResponse,
			expect
		);
		expect(deleted.result?.deleted).toBe(true);

		const listResponse = await mf.dispatchFetch(
			`${BASE_URL}/email/${worker}/routing`
		);
		const data = await expectValidResponse(
			listResponse,
			zEmailListRoutingActivityResponse,
			expect
		);
		expect(data.result ?? []).toHaveLength(0);
	});

	test("dispatches a test email, deriving the envelope from the message headers", async ({
		expect,
	}) => {
		// The body carries only the raw message; the `From:`/`To:` headers (which
		// include display names) are parsed server-side into the SMTP envelope.
		const response = await mf.dispatchFetch(
			`${BASE_URL}/email/${worker}/send`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					raw: incomingEmail("forward@example.com"),
				}),
			}
		);
		await expectValidResponse(response, zEmailSendTestResponse, expect);

		const records = await waitForRoutingRecords(
			mf,
			worker,
			(r) => r.some((e) => e.action === "worker"),
			expect
		);
		// The envelope recipient recorded by the routing handler is the bare
		// address extracted from the named `To:` header.
		const workerRow = records.find((e) => e.action === "worker");
		expect(workerRow?.to).toBe("forward@example.com");
		expect(workerRow?.from).toBe("someone@example.com");
	});

	test("rejects a message missing From/To headers", async ({ expect }) => {
		const response = await mf.dispatchFetch(
			`${BASE_URL}/email/${worker}/send`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					raw: dedent`
						Subject: no addresses
						Message-ID: <no-addr@example.com>

						body`,
				}),
			}
		);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("From and To");
	});

	test("rejects test emails over 1 MiB", async ({ expect }) => {
		const response = await mf.dispatchFetch(
			`${BASE_URL}/email/${worker}/send`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					raw: "x".repeat(1024 * 1024 + 1),
				}),
			}
		);
		expect(response.ok).toBe(false);
		await response.text();
	});
});

describe("Email API — sending", () => {
	const worker = "sending-worker";
	let mf: Miniflare;

	beforeAll(async () => {
		mf = new Miniflare({
			name: worker,
			inspectorPort: 0,
			compatibilityDate: "2025-03-17",
			modules: true,
			script: SENDING_WORKER,
			email: {
				send_email: [
					{ name: "SEND_EMAIL", destination_address: "a@example.com" },
				],
			},
			unsafeLocalExplorer: true,
		});
	});

	afterAll(async () => {
		await disposeWithRetry(mf);
	});

	test("fans out one delivered row per recipient sharing a message id", async ({
		expect,
	}) => {
		const sendResponse = await mf.dispatchFetch("http://localhost", {
			method: "POST",
			body: JSON.stringify({
				from: "sender@example.com",
				to: "a@example.com",
				cc: "b@example.com",
				bcc: "c@example.com",
				subject: "fan out",
				text: "hello recipients",
			}),
		});
		await sendResponse.text();

		const records = await vi.waitFor(
			async () => {
				const response = await mf.dispatchFetch(
					`${BASE_URL}/email/${worker}/sending`
				);
				const data = await expectValidResponse(
					response,
					zEmailListSendingActivityResponse,
					expect
				);
				const result = data.result ?? [];
				if (result.length < 3) {
					throw new Error(
						`Expected 3 sending rows, got:\n${JSON.stringify(result, null, 2)}`
					);
				}
				return result;
			},
			{ timeout: 5_000, interval: 100 }
		);

		const recipients = records.map((e) => e.envelopeTos).sort();
		expect(recipients).toEqual([
			"a@example.com",
			"b@example.com",
			"c@example.com",
		]);
		// All fan-out rows share a single message id.
		const messageIds = new Set(records.map((e) => e.messageId));
		expect(messageIds.size).toBe(1);
		records.forEach((e) => expect(e.status).toBe("delivered"));
	});

	test("records an error row when sending validation fails", async ({
		expect,
	}) => {
		// Sending to a destination the binding disallows fails validation,
		// producing an error row (the `from` is still valid so the failure is
		// captured, not lost).
		try {
			const badResponse = await mf.dispatchFetch("http://localhost", {
				method: "POST",
				body: JSON.stringify({
					from: "sender@example.com",
					to: "blocked@example.com",
					subject: "bad",
					text: "disallowed recipient",
				}),
			});
			await badResponse.text();
		} catch {
			// The Worker rethrows; the request may reject. Activity is still logged.
		}

		await vi.waitFor(
			async () => {
				const response = await mf.dispatchFetch(
					`${BASE_URL}/email/${worker}/sending`
				);
				const data = await expectValidResponse(
					response,
					zEmailListSendingActivityResponse,
					expect
				);
				const errorRow = (data.result ?? []).find((e) => e.status === "error");
				if (!errorRow) {
					throw new Error(
						`No error row found in:\n${JSON.stringify(data.result, null, 2)}`
					);
				}
				expect(errorRow.status).toBe("error");
			},
			{ timeout: 5_000, interval: 100 }
		);
	});

	test("stores a parseable body when the sender supplies an empty html string", async ({
		expect,
	}) => {
		// Mirrors real senders (e.g. via `letterparser`) that pass `html: ""` for
		// a text-only message. The stored `.eml` must still expose the text body.
		const sendResponse = await mf.dispatchFetch("http://localhost", {
			method: "POST",
			body: JSON.stringify({
				from: "sender@example.com",
				to: "a@example.com",
				subject: "empty html",
				text: "the real body",
				html: "",
			}),
		});
		await sendResponse.text();

		const records = await vi.waitFor(
			async () => {
				const response = await mf.dispatchFetch(
					`${BASE_URL}/email/${worker}/sending`
				);
				const data = await expectValidResponse(
					response,
					zEmailListSendingActivityResponse,
					expect
				);
				const result = (data.result ?? []).filter(
					(e) => e.subject === "empty html"
				);
				if (result.length === 0) {
					throw new Error("No 'empty html' row yet");
				}
				return result;
			},
			{ timeout: 5_000, interval: 100 }
		);

		const messageId = records[0]?.messageId;
		expect(messageId).toBeTruthy();

		const rawResponse = await mf.dispatchFetch(
			`${BASE_URL}/email/${worker}/raw?` +
				new URLSearchParams({ messageId: String(messageId) }).toString()
		);
		expect(rawResponse.status).toBe(200);
		const email = await PostalMime.parse(await rawResponse.text());
		expect(email.text?.trim()).toBe("the real body");
	});
});
