// ---------------------------------------------------------------------------
// Email result vocabulary — single source of truth.
//
// Every surface that names the outcome of an email event (the activity-log
// Result column and the Log Detail flow node titles) derives its label and
// badge variant from this module, so the terminology can never drift between
// them.
//
// This is the local-explorer projection of Miniflare's simplified, local-only
// email activity model:
//
//   - routing status: delivered | dropped | deliveryFailed | error
//   - routing action: forward | worker | drop | unknown
//   - sending status: delivered | error
//
// with two dash-style refinements derived from (status, action):
//
//   - `handled`   — routing `dropped` + `action: 'worker'` (a successful
//                   hand-off to an Email Worker, not a drop).
//   - `forwarded` — routing `delivered` + `action: 'forward'` (a forward() to
//                   a configured destination). A `delivered` from a Worker
//                   `.reply()`/`.send()` (action `unknown`) stays `delivered`.
// ---------------------------------------------------------------------------

import type { BadgeVariant } from "@cloudflare/kumo";

export type ResultKind =
	| "delivered"
	| "forwarded"
	| "handled"
	| "dropped"
	| "deliveryFailed"
	| "error"
	| "unknown";

export interface ResolveResultArgs {
	/** Raw record `status` (camelCase). */
	status: string;
	/** Routing `action` (`forward` | `worker` | `drop` | `unknown`). */
	action?: string;
}

/**
 * Map a record's `status` (+ routing `action`) to the display `ResultKind`.
 * Unrecognized statuses fall back to `unknown`.
 */
export function resolveResult({
	status,
	action,
}: ResolveResultArgs): ResultKind {
	// Worker hand-off: the backend records `dropped`, but the mail reached the
	// user's Worker — a successful handoff, not a drop.
	if (status === "dropped" && action === "worker") {
		return "handled";
	}

	switch (status) {
		case "delivered":
			return action === "forward" ? "forwarded" : "delivered";
		case "deliveryFailed":
			return "deliveryFailed";
		case "dropped":
			return "dropped";
		case "error":
			return "error";
		default:
			return "unknown";
	}
}

/** Human-readable label for each result kind. */
export const RESULT_LABEL: Record<ResultKind, string> = {
	delivered: "Delivered",
	forwarded: "Forwarded",
	handled: "Handled",
	dropped: "Dropped",
	deliveryFailed: "Delivery failed",
	error: "Error",
	unknown: "Unknown",
};

/** Kumo Badge variant for the activity-log Result column. */
export const RESULT_BADGE_VARIANT: Record<ResultKind, BadgeVariant> = {
	delivered: "success",
	forwarded: "success",
	handled: "outline",
	dropped: "outline",
	unknown: "outline",
	deliveryFailed: "error",
	error: "error",
};
