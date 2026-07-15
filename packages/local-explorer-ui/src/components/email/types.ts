import type {
	EmailRoutingActivityRecord,
	EmailSendingActivityRecord,
} from "../../api";

/** A single email activity event, discriminated by `direction`. */
export type EmailActivityRecord =
	| EmailRoutingActivityRecord
	| EmailSendingActivityRecord;

export type EmailDirection = "routing" | "sending";

/**
 * One envelope-recipient stream within a message's lifecycle.
 *
 * Routing messages always have exactly one recipient. Sending messages can fan
 * a single `messageId` out to multiple envelope recipients; the flow renders
 * one parallel branch per recipient.
 */
export interface LogDetailRecipient {
	envelopeTos: string;
	events: EmailActivityRecord[];
}

/** The normalized shape consumed by the Log Detail flow. */
export interface LogDetailMessage {
	direction: EmailDirection;
	messageId: string;
	subject: string;
	from: string;
	recipients: LogDetailRecipient[];
}

/** The envelope recipient for an event (routing `to` / sending `envelopeTos`). */
export function recipientOf(record: EmailActivityRecord): string {
	return record.direction === "routing" ? record.to : record.envelopeTos;
}
