import { recipientOf } from "./types";
import type {
	EmailActivityRecord,
	EmailDirection,
	LogDetailMessage,
	LogDetailRecipient,
} from "./types";

/**
 * Normalizes a flat list of activity records into the `LogDetailMessage` shape
 * consumed by the Log Detail flow.
 *
 * - **Sending** rows are grouped by envelope recipient (`envelopeTos`), so a
 *   fan-out renders one branch per recipient.
 * - **Routing** rows all belong to a single message lifecycle (the worker row
 *   plus any `forward()` deliveries share one `messageId` and all carry the
 *   original envelope recipient as their `to`), so they coalesce into a single
 *   recipient stream keyed on that recipient. This renders the lifecycle as one
 *   left-to-right sequence rather than misleading parallel branches.
 * - Sorts each group ascending by `datetime`.
 * - Derives the top-level constants (`subject`, `from`, `messageId`) from the
 *   first row.
 *
 * Returns `null` when the input is empty so callers can render the
 * "message not found" empty state without an extra check.
 */
export function groupEvents(
	rows: readonly EmailActivityRecord[],
	direction: EmailDirection
): LogDetailMessage | null {
	const first = rows[0];
	if (!first) {
		return null;
	}

	const sortByDatetime = (
		a: EmailActivityRecord,
		b: EmailActivityRecord
	): number => a.datetime.localeCompare(b.datetime);

	const recipients =
		direction === "routing"
			? // Coalesce the whole routing lifecycle into one recipient stream so it
				// renders as a single left-to-right sequence. The original envelope
				// recipient (the address the worker received on) labels the stream.
				[
					{
						envelopeTos: recipientOf(first),
						events: [...rows].sort(sortByDatetime),
					},
				]
			: groupByEnvelope(rows, sortByDatetime);

	return {
		direction,
		messageId: first.messageId ?? "",
		subject: first.subject,
		from: first.from,
		recipients,
	};
}

/**
 * Groups sending rows by their envelope recipient (`envelopeTos`) so a fan-out
 * to multiple recipients renders one parallel branch each, ordered by the first
 * event's datetime in each branch.
 */
function groupByEnvelope(
	rows: readonly EmailActivityRecord[],
	sortByDatetime: (a: EmailActivityRecord, b: EmailActivityRecord) => number
): LogDetailRecipient[] {
	const byEnvelope = new Map<string, EmailActivityRecord[]>();
	for (const row of rows) {
		const envelope = recipientOf(row) || "";
		const bucket = byEnvelope.get(envelope);
		if (bucket) {
			bucket.push(row);
		} else {
			byEnvelope.set(envelope, [row]);
		}
	}

	return Array.from(byEnvelope.entries())
		.map(([envelopeTos, events]) => ({
			envelopeTos,
			events: [...events].sort(sortByDatetime),
		}))
		.sort((a, b) => {
			const da = a.events[0]?.datetime ?? "";
			const db = b.events[0]?.datetime ?? "";
			return da.localeCompare(db);
		});
}

/**
 * Collects every event belonging to the same message lifecycle as `target`
 * from the full record list. Events are matched by shared `messageId`; when
 * the target has no `messageId` (e.g. a validation-failure error row), only the
 * target itself is returned.
 */
export function eventsForMessage(
	all: readonly EmailActivityRecord[],
	target: EmailActivityRecord
): EmailActivityRecord[] {
	if (!target.messageId) {
		return [target];
	}
	return all.filter((record) => record.messageId === target.messageId);
}
