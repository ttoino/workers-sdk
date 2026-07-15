import type { Attachment } from "postal-mime";

/**
 * Helpers for rendering the activity-log email preview.
 *
 * `postal-mime` parses the raw message into `{ html, text, attachments }`.
 * Inline images (logos, signatures) arrive as attachments with a `Content-Id`,
 * referenced from the HTML as `<img src="cid:...">` — which the browser can't
 * resolve, so they'd silently disappear. We turn each inline attachment into a
 * `data:` URL keyed by its (angle-bracket-stripped) content id and splice them
 * into the HTML before rendering.
 *
 * The HTML is rendered inside a sandboxed iframe; on top of that we sanitize
 * with the native HTML Sanitizer API (`Element.setHTML`) when the browser
 * supports it. `sanitizeEmailHtml` reports whether sanitization actually ran so
 * callers can gate surfaces that lack the iframe sandbox (e.g. opening the
 * message in a new tab).
 */

/** Strip the surrounding angle brackets postal-mime keeps on `contentId`. */
function stripAngleBrackets(contentId: string): string {
	return contentId.replace(/^<|>$/g, "");
}

/**
 * Build a `contentId -> data:URL` map from a parsed message's attachments.
 * Only attachments that carry a `contentId` (inline resources) are included,
 * and only when their content is a base64 string (postal-mime is parsed with
 * `attachmentEncoding: 'base64'`).
 */
export function buildInlineImageMap(
	attachments: Attachment[] | undefined
): Record<string, string> {
	const map: Record<string, string> = {};
	for (const attachment of attachments ?? []) {
		if (!attachment.contentId) {
			continue;
		}
		if (typeof attachment.content !== "string") {
			continue;
		}
		if (!attachment.mimeType) {
			continue;
		}
		map[stripAngleBrackets(attachment.contentId)] =
			`data:${attachment.mimeType};base64,${attachment.content}`;
	}
	return map;
}

/**
 * Replace `cid:` references in the HTML with their inline data URLs. Content
 * ids are unique, opaque tokens, so a literal `split`/`join` is both safe and
 * avoids regex escaping.
 */
export function inlineCidImages(
	html: string,
	cidMap: Record<string, string>
): string {
	let result = html;
	for (const [cid, dataUrl] of Object.entries(cidMap)) {
		result = result.split(`cid:${cid}`).join(dataUrl);
	}
	return result;
}

/**
 * Real (downloadable) attachments — i.e. those with `disposition:
 * 'attachment'`. Inline resources (`disposition: 'inline'`/`related`, typically
 * `cid:` images) are excluded because they already render in the HTML body.
 */
export function getDownloadableAttachments(
	attachments: Attachment[] | undefined
): Attachment[] {
	return (attachments ?? []).filter((a) => a.disposition === "attachment");
}

/** A `data:` URL for downloading an attachment (postal-mime `content` is base64). */
export function attachmentDataUrl(attachment: Attachment): string {
	return typeof attachment.content === "string"
		? `data:${attachment.mimeType || "application/octet-stream"};base64,${attachment.content}`
		: "";
}

/** Decoded byte size of a base64 attachment (0 when the content isn't base64). */
export function attachmentByteSize(attachment: Attachment): number {
	if (typeof attachment.content !== "string") {
		return 0;
	}
	const base64 = attachment.content.replace(/=+$/, "");
	return Math.floor((base64.length * 3) / 4);
}

interface SanitizedHtml {
	html: string;
	/** Whether the native HTML Sanitizer API actually ran. */
	sanitized: boolean;
}

/**
 * Sanitize email HTML with the native HTML Sanitizer API when available.
 *
 * Uses `Element.setHTML` on a detached element (no resource loads / script
 * execution) and reads back the sanitized serialization. When the API is
 * unavailable, returns the input untouched with `sanitized: false` — the caller
 * is expected to render it inside a sandboxed iframe, which contains any
 * unsanitized markup.
 *
 * A **blocklist** config (`{ removeElements: [] }`) is passed rather than the
 * default sanitizer: the default is built for rich-text/UGC snippets and strips
 * `<img>`, `<style>`, and `style`/`class` attributes, which erases all email
 * formatting and images. The blocklist form removes only the always-unsafe
 * items (`<script>`, `<iframe>`, `<object>`, `<embed>`, event handlers) while
 * keeping presentational markup, so the preview renders faithfully. Rendering
 * safety is anchored by the iframe `sandbox` regardless.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/HTML_Sanitizer_API
 */
export function sanitizeEmailHtml(html: string): SanitizedHtml {
	// `setHTML` is not yet in the DOM lib types; the annotation adds it as an
	// optional method, which a plain `HTMLDivElement` satisfies — so no cast is
	// needed and feature-detection stays type-safe.
	const el:
		| (HTMLDivElement & {
				setHTML?: (input: string, options?: unknown) => void;
		  })
		| undefined = document?.createElement("div");

	if (!el || typeof el.setHTML !== "function") {
		return { html, sanitized: false };
	}

	el.setHTML(html, { sanitizer: { removeElements: [] } });
	return { html: el.innerHTML, sanitized: true };
}
