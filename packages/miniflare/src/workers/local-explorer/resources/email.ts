import PostalMime from "postal-mime";
import { CoreHeaders, CorePaths } from "../../core";
import {
	aggregateListResults,
	fetchFromPeer,
	getPeerUrlsIfAggregating,
} from "../aggregation";
import { errorResponse, wrapResponse } from "../common";
import type {
	EmailActivityDirection,
	EmailActivityRecord,
} from "../../email/types";
import type { AppContext } from "../common";
import type { Email } from "postal-mime";

// ============================================================================
// Error Codes
// ============================================================================

const EMAIL_ERROR_MESSAGE_NOT_FOUND = 10601;
const EMAIL_ERROR_RAW_NOT_FOUND = 10602;
const EMAIL_ERROR_SEND_FAILED = 10603;

/**
 * Local email dispatch uses a JSRPC transport capped at 1 MiB, matching the
 * routing handler's own limit.
 */
const MAX_TEST_EMAIL_BYTES = 1024 * 1024;

// ============================================================================
// Send test email
// ============================================================================

export interface SendTestEmailBody {
	/**
	 * A complete RFC 5322 message. The UI builds this from the builder fields or
	 * a raw paste. The envelope MAIL FROM / RCPT TO addresses are derived from
	 * the message's own `From:` and `To:` headers.
	 */
	raw: string;
}

/**
 * Dispatches a test email to a Worker through the entry service's inbound email
 * path, so it exercises the real routing handler (and thus activity logging).
 *
 * The SMTP envelope (`from`/`to`) is parsed from the message's `From:` and
 * `To:` headers — a local convenience so developers don't restate addresses
 * that already live in the message. (Production keeps envelope and headers
 * distinct; that distinction is only meaningful for real inbound mail.)
 */
export async function sendTestEmail(
	c: AppContext,
	worker: string,
	body: SendTestEmailBody
) {
	const rawBytes = new TextEncoder().encode(body.raw).byteLength;
	if (rawBytes > MAX_TEST_EMAIL_BYTES) {
		return errorResponse(
			400,
			EMAIL_ERROR_SEND_FAILED,
			"Email exceeds the local 1 MiB limit for test messages."
		);
	}

	let parsed: Email;
	try {
		parsed = await PostalMime.parse(body.raw);
	} catch (e) {
		return errorResponse(
			400,
			EMAIL_ERROR_SEND_FAILED,
			`Could not parse the message: ${e instanceof Error ? e.message : String(e)}`
		);
	}

	const from = parsed.from?.address;
	const to = parsed.to?.[0]?.address;
	if (!from || !to) {
		return errorResponse(
			400,
			EMAIL_ERROR_SEND_FAILED,
			"The message must include From and To headers with valid addresses."
		);
	}

	const url = new URL(`http://localhost${CorePaths.EMAIL}`);
	url.searchParams.set("from", from);
	url.searchParams.set("to", to);

	const response = await c.env.MINIFLARE_EXPLORER_ENTRY_SERVICE.fetch(
		url.toString(),
		{
			method: "POST",
			// Force delivery to the selected Worker regardless of routes.
			headers: { [CoreHeaders.ROUTE_OVERRIDE]: worker },
			body: body.raw,
		}
	);

	const message = await response.text();
	if (!response.ok) {
		return errorResponse(response.status, EMAIL_ERROR_SEND_FAILED, message);
	}

	return c.json(wrapResponse({ message }));
}

// ============================================================================
// Helpers
// ============================================================================

/** Base loopback path for a Worker's email activity. */
function activityBase(worker: string): string {
	return `http://localhost/core/email-activity/${encodeURIComponent(worker)}`;
}

/**
 * Reads all activity records for a Worker from the local (Node.js) store. A
 * Worker with no local activity — including Workers owned by a peer instance —
 * yields an empty array.
 */
async function readLocalRecords(
	c: AppContext,
	worker: string
): Promise<EmailActivityRecord[]> {
	const response = await c.env.MINIFLARE_LOOPBACK.fetch(activityBase(worker));
	if (!response.ok) {
		return [];
	}
	return (await response.json()) as EmailActivityRecord[];
}

/**
 * Attempts a request against every peer instance's explorer API, returning the
 * first successful response. Used for per-message lookups, where a given Worker
 * (and therefore its activity) lives on exactly one instance.
 */
async function fetchFirstOkFromPeers(
	c: AppContext,
	apiPath: string,
	init?: RequestInit
): Promise<Response | null> {
	const peerUrls = await getPeerUrlsIfAggregating(c);
	for (const url of peerUrls) {
		const response = await fetchFromPeer(url, apiPath, init);
		if (response?.ok) {
			return response;
		}
	}
	return null;
}

// ============================================================================
// Resource handlers
// ============================================================================

/**
 * Lists a Worker's email activity for one direction (routing or sending),
 * aggregated across all instances. Records are returned newest-first.
 */
export async function listEmailActivity(
	c: AppContext,
	worker: string,
	direction: EmailActivityDirection
) {
	const local = (await readLocalRecords(c, worker)).filter(
		(record) => record.direction === direction
	);

	const apiPath = `/email/${encodeURIComponent(worker)}/${direction}`;
	const all = await aggregateListResults(c, local, apiPath);

	all.sort((a, b) => b.datetime.localeCompare(a.datetime));
	return c.json(wrapResponse(all));
}

/** Returns a single activity record by id, searching peers if necessary. */
export async function getEmailMessage(
	c: AppContext,
	worker: string,
	id: string
) {
	const response = await c.env.MINIFLARE_LOOPBACK.fetch(
		`${activityBase(worker)}/records/${encodeURIComponent(id)}`
	);
	if (response.ok) {
		const record = (await response.json()) as EmailActivityRecord;
		return c.json(wrapResponse(record));
	}

	const peerResponse = await fetchFirstOkFromPeers(
		c,
		`/email/${encodeURIComponent(worker)}/messages/${encodeURIComponent(id)}`
	);
	if (peerResponse) {
		return new Response(peerResponse.body, peerResponse);
	}

	return errorResponse(404, EMAIL_ERROR_MESSAGE_NOT_FOUND, "Message not found");
}

/**
 * Returns the raw `.eml` for a message. The preview treats a 404 as "raw not
 * available" (e.g. a forward event, which carries no stored body).
 */
export async function getEmailRaw(
	c: AppContext,
	worker: string,
	messageId: string
) {
	const response = await c.env.MINIFLARE_LOOPBACK.fetch(
		`${activityBase(worker)}/raw/${encodeURIComponent(messageId)}`
	);
	if (response.ok) {
		return new Response(response.body, {
			headers: { "Content-Type": "message/rfc822" },
		});
	}

	const peerResponse = await fetchFirstOkFromPeers(
		c,
		`/email/${encodeURIComponent(worker)}/raw?messageId=${encodeURIComponent(messageId)}`
	);
	if (peerResponse) {
		return new Response(peerResponse.body, {
			headers: { "Content-Type": "message/rfc822" },
		});
	}

	return errorResponse(404, EMAIL_ERROR_RAW_NOT_FOUND, "Raw email not found");
}

/** Clears a Worker's email activity across all instances. */
export async function deleteEmailActivity(c: AppContext, worker: string) {
	await c.env.MINIFLARE_LOOPBACK.fetch(activityBase(worker), {
		method: "DELETE",
	});

	const peerUrls = await getPeerUrlsIfAggregating(c);
	await Promise.all(
		peerUrls.map((url) =>
			fetchFromPeer(url, `/email/${encodeURIComponent(worker)}`, {
				method: "DELETE",
			})
		)
	);

	return c.json(wrapResponse({ deleted: true }));
}
