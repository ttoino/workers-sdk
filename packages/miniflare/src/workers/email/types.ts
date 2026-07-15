// Types for the Email Sending API MessageBuilder interface

export type EmailAttachment =
	| {
			disposition: "inline";
			contentId: string;
			filename: string;
			type: string;
			content: string | ArrayBuffer | ArrayBufferView;
	  }
	| {
			disposition: "attachment";
			contentId?: undefined;
			filename: string;
			type: string;
			content: string | ArrayBuffer | ArrayBufferView;
	  };

export interface EmailAddress {
	name: string;
	email: string;
}

export interface MessageBuilder {
	from: string | EmailAddress;
	to: string | EmailAddress | (string | EmailAddress)[];
	subject: string;
	replyTo?: string | EmailAddress;
	cc?: string | EmailAddress | (string | EmailAddress)[];
	bcc?: string | EmailAddress | (string | EmailAddress)[];
	headers?: Record<string, string>;
	text?: string;
	html?: string;
	attachments?: EmailAttachment[];
}

// ---------------------------------------------------------------------------
// Email activity log
//
// The local explorer surfaces a simplified, local-only activity log for both
// incoming (routing) and outgoing (sending) email. The routing and sending
// records are deliberately distinct, mirroring the production
// `emailRoutingAdaptive` / `emailSendingAdaptive` GraphQL rows (minus fields
// with no local source: spf/dkim/dmarc/arc, spam scoring, adaptive analytics).
//
// `status` and `action` reuse the same fwdr `EmailStatus` vocabulary the
// dashboard uses so the shared result-badge / flow logic can be reused as-is.
// Like production, a single message can produce multiple rows sharing a
// `messageId` (one `worker` handoff row plus one `unknown` row per
// `forward()`; each `reply()` is a new message with its own `messageId`).
// ---------------------------------------------------------------------------

export type EmailActivityDirection = "routing" | "sending";

/** Routing outcome. `unknown` is a worker-initiated `forward()`/`reply()`. */
export type RoutingAction = "forward" | "worker" | "drop" | "unknown";

export type RoutingStatus =
	| "delivered"
	| "dropped"
	| "deliveryFailed"
	| "error";

export type SendingStatus = "delivered" | "error";

interface EmailActivityBase {
	/** Assigned by the Node.js loopback endpoint when written. */
	id: string;
	/** ISO 8601, assigned by the Node.js loopback endpoint when written. */
	datetime: string;
	from: string;
	subject: string;
	messageId?: string;
	errorDetail?: string;
	/** 0 | 1 — non-delivery report. Always 0 locally, kept for schema parity. */
	isNDR: number;
	/** 0 | 1 — marks the terminal event of a message's lifecycle. */
	isLastEvent: number;
}

/** One incoming-email event. Multiple rows can share a `messageId`. */
export interface RoutingActivityRecord extends EmailActivityBase {
	direction: "routing";
	/** Envelope recipient (routing only). */
	to: string;
	/** Routing action (routing only). */
	action: RoutingAction;
	/** Handling Email Worker name (routing only). */
	worker: string;
	status: RoutingStatus;
}

/** One outgoing-email event per recipient (to/cc/bcc). */
export interface SendingActivityRecord extends EmailActivityBase {
	direction: "sending";
	/** The single envelope recipient for this event (sending only). */
	envelopeTos: string;
	status: SendingStatus;
}

export type EmailActivityRecord = RoutingActivityRecord | SendingActivityRecord;

/**
 * Payload written by the activity writers via the loopback endpoint. `id`,
 * `datetime` and `isLastEvent` (recomputed per message) are managed Node-side;
 * `rawBase64` (when present) is stored keyed by `messageId`.
 */
export type EmailActivityInput = (
	| Omit<RoutingActivityRecord, "id" | "datetime">
	| Omit<SendingActivityRecord, "id" | "datetime">
) & {
	rawBase64?: string;
};
