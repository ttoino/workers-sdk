import { describe, test } from "vitest";
import {
	eventsForMessage,
	groupEvents,
} from "../../components/email/groupEvents";
import type {
	EmailRoutingActivityRecord,
	EmailSendingActivityRecord,
} from "../../api";

// ---------------------------------------------------------------------------
// Test fixtures
//
// `groupEvents` carries the raw record `status` (+ routing `action`) through
// unchanged — the displayed outcome is derived at render time by
// `resolveResult` (covered by `resultLabel.test.ts`). These factories produce
// minimally valid rows so each test only spells out the bits it cares about.
// ---------------------------------------------------------------------------

function routingRow(
	overrides: Partial<EmailRoutingActivityRecord> = {}
): EmailRoutingActivityRecord {
	return {
		id: "evt-1",
		datetime: "2026-01-01T12:00:00.000Z",
		direction: "routing",
		from: "sender@example.com",
		to: "recipient@example.test",
		subject: "Hello world",
		action: "worker",
		worker: "my-worker",
		status: "dropped",
		messageId: "msg-1",
		isNDR: 0,
		isLastEvent: 0,
		...overrides,
	};
}

function sendingRow(
	overrides: Partial<EmailSendingActivityRecord> = {}
): EmailSendingActivityRecord {
	return {
		id: "evt-1",
		datetime: "2026-01-01T12:00:00.000Z",
		direction: "sending",
		from: "sender@example.com",
		envelopeTos: "recipient@example.test",
		subject: "Hello world",
		status: "delivered",
		messageId: "msg-1",
		isNDR: 0,
		isLastEvent: 0,
		...overrides,
	};
}

describe("groupEvents", () => {
	test("returns null when there are no rows", ({ expect }) => {
		expect(groupEvents([], "sending")).toBeNull();
	});

	test("derives the top-level constants from the first row", ({ expect }) => {
		const result = groupEvents(
			[
				sendingRow({
					messageId: "msg-XYZ",
					subject: "Welcome aboard",
					from: "alice@brand.io",
				}),
			],
			"sending"
		);
		expect(result).toMatchObject({
			direction: "sending",
			messageId: "msg-XYZ",
			subject: "Welcome aboard",
			from: "alice@brand.io",
		});
	});

	test("leaves the message-level messageId empty when the first row has none", ({
		expect,
	}) => {
		const result = groupEvents(
			[sendingRow({ messageId: undefined, id: "session-9" })],
			"sending"
		);
		expect(result?.messageId).toBe("");
	});

	test("produces a single routing recipient carrying the raw status + action", ({
		expect,
	}) => {
		const result = groupEvents(
			[routingRow({ status: "delivered", action: "unknown" })],
			"routing"
		);
		expect(result?.recipients).toHaveLength(1);
		expect(result?.recipients[0]?.events).toHaveLength(1);
		const event = result?.recipients[0]?.events[0];
		expect(event?.direction).toBe("routing");
		expect(event?.status).toBe("delivered");
		if (event?.direction === "routing") {
			expect(event.action).toBe("unknown");
		}
	});

	test("coalesces routing rows into one recipient stream even across differing `to`", ({
		expect,
	}) => {
		// A routing lifecycle spans stages with different `to` values (the worker
		// receives on the incoming address, then `forward()` delivers to another
		// destination). They must still collapse into one left-to-right stream —
		// not fan out into parallel branches — labelled by the incoming recipient.
		const result = groupEvents(
			[
				routingRow({
					id: "a",
					action: "worker",
					status: "dropped",
					to: "incoming@example.test",
				}),
				routingRow({
					id: "b",
					datetime: "2026-01-01T12:00:01.000Z",
					action: "unknown",
					status: "delivered",
					to: "forwarded@elsewhere.test",
				}),
			],
			"routing"
		);
		expect(result?.recipients).toHaveLength(1);
		expect(result?.recipients[0]?.envelopeTos).toBe("incoming@example.test");
		expect(result?.recipients[0]?.events.map((e) => e.status)).toEqual([
			"dropped",
			"delivered",
		]);
	});

	test("fans sending rows out by envelopeTos for multi-recipient messages", ({
		expect,
	}) => {
		const result = groupEvents(
			[
				sendingRow({ id: "a", envelopeTos: "alice@test.io" }),
				sendingRow({
					id: "b",
					envelopeTos: "bob@test.io",
					datetime: "2026-01-01T12:00:00.500Z",
				}),
			],
			"sending"
		);
		expect(result?.recipients).toHaveLength(2);
		expect(result?.recipients[0]?.envelopeTos).toBe("alice@test.io");
		expect(result?.recipients[1]?.envelopeTos).toBe("bob@test.io");
	});

	test("sorts events within a recipient ascending by datetime regardless of input order", ({
		expect,
	}) => {
		const result = groupEvents(
			[
				sendingRow({ id: "late", datetime: "2026-01-01T12:00:05.000Z" }),
				sendingRow({ id: "mid", datetime: "2026-01-01T12:00:02.000Z" }),
				sendingRow({ id: "early", datetime: "2026-01-01T12:00:00.000Z" }),
			],
			"sending"
		);
		expect(result?.recipients[0]?.events.map((e) => e.id)).toEqual([
			"early",
			"mid",
			"late",
		]);
	});

	test("orders recipients by their first event's datetime", ({ expect }) => {
		const result = groupEvents(
			[
				sendingRow({
					id: "b1",
					envelopeTos: "bob@test.io",
					datetime: "2026-01-01T12:00:02.000Z",
				}),
				sendingRow({
					id: "a1",
					envelopeTos: "alice@test.io",
					datetime: "2026-01-01T12:00:00.000Z",
				}),
			],
			"sending"
		);
		expect(result?.recipients.map((r) => r.envelopeTos)).toEqual([
			"alice@test.io",
			"bob@test.io",
		]);
	});

	test("preserves errorDetail and the raw status verbatim", ({ expect }) => {
		const result = groupEvents(
			[
				sendingRow({ id: "ok", status: "delivered" }),
				sendingRow({
					id: "failed",
					datetime: "2026-01-01T12:00:01.000Z",
					status: "error",
					errorDetail: "email to blocked@example.com not allowed",
				}),
			],
			"sending"
		);
		const [first, second] = result?.recipients[0]?.events ?? [];
		expect(first?.status).toBe("delivered");
		expect(first?.errorDetail).toBeUndefined();
		expect(second?.status).toBe("error");
		expect(second?.errorDetail).toBe(
			"email to blocked@example.com not allowed"
		);
	});
});

describe("eventsForMessage", () => {
	test("collects every event sharing the target's messageId", ({ expect }) => {
		const target = sendingRow({
			id: "b",
			messageId: "msg-1",
			envelopeTos: "b@test.io",
		});
		const all = [
			sendingRow({ id: "a", messageId: "msg-1", envelopeTos: "a@test.io" }),
			target,
			sendingRow({ id: "c", messageId: "msg-2", envelopeTos: "c@test.io" }),
		];
		const result = eventsForMessage(all, target);
		expect(result.map((e) => e.id)).toEqual(["a", "b"]);
	});

	test("returns only the target when it has no messageId", ({ expect }) => {
		const target = sendingRow({ id: "orphan", messageId: undefined });
		const all = [target, sendingRow({ id: "other", messageId: undefined })];
		expect(eventsForMessage(all, target)).toEqual([target]);
	});
});
