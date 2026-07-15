// Shared helpers for rendering RFC 5322 / MIME messages from the email
// builder types. Used by the routing handler (`core/email.ts`, for
// builder-style replies) and the `send_email` binding (to synthesize a
// previewable `.eml` for the `MessageBuilder` send path).

import type { EmailAddress, EmailAttachment, MessageBuilder } from "./types";

/**
 * Extracts the bare email address from a string (which may be in
 * `"Name" <address>` or plain address format) or `EmailAddress` object.
 */
export function extractEmailAddress(addr: string | EmailAddress): string {
	if (typeof addr !== "string") {
		return addr.email;
	}

	const match = addr.match(/<([^>]+)>$/);
	return match ? match[1].trim() : addr.trim();
}

/** Formats an email address for a header value. */
export function formatEmailAddress(addr: string | EmailAddress): string {
	if (typeof addr === "string") {
		return addr;
	}

	return `"${addr.name}" <${addr.email}>`;
}

function formatContentId(contentId: string): string {
	return contentId.startsWith("<") && contentId.endsWith(">")
		? contentId
		: `<${contentId}>`;
}

export function encodeBase64(
	content: string | ArrayBuffer | ArrayBufferView
): string {
	let bytes: Uint8Array;
	if (typeof content === "string") {
		bytes = new TextEncoder().encode(content);
	} else if (content instanceof ArrayBuffer) {
		bytes = new Uint8Array(content);
	} else {
		bytes = new Uint8Array(
			content.buffer,
			content.byteOffset,
			content.byteLength
		);
	}

	let binary = "";
	for (let i = 0; i < bytes.byteLength; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}

	return btoa(binary)
		.replace(/.{1,76}/g, "$&\r\n")
		.trimEnd();
}

export function renderAttachment(attachment: EmailAttachment): string {
	// Formats the mime parameter
	const filename = attachment.filename.replace(/["\\\r\n]/g, "_");
	const headers = [
		"Content-Transfer-Encoding: base64",
		`Content-Disposition: ${attachment.disposition}; filename="${filename}"`,
		`Content-Type: ${attachment.type}; name="${filename}"`,
	] satisfies string[];

	if (attachment.contentId !== undefined) {
		headers.push(`Content-ID: ${formatContentId(attachment.contentId)}`);
	}

	return `${headers.join("\r\n")}\r\n\r\n${encodeBase64(attachment.content)}`;
}

/** A rendered MIME entity: the value for a `Content-Type` header + its body. */
interface RenderedContent {
	contentType: string;
	body: string;
}

function partBoundary(): string {
	return `----=_Part_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Assembles a `multipart/*` body from already-rendered child parts. */
function renderMultipart(
	subtype: "mixed" | "alternative",
	parts: string[]
): RenderedContent {
	const boundary = partBoundary();
	return {
		contentType: `multipart/${subtype}; boundary="${boundary}"`,
		body: `${parts.map((part) => `--${boundary}\r\n${part}`).join("\r\n")}\r\n--${boundary}--`,
	};
}

/** A single leaf part (headers + blank line + body) for embedding in a multipart. */
function renderLeafPart({ contentType, body }: RenderedContent): string {
	return `Content-Type: ${contentType}\r\n\r\n${body}`;
}

/**
 * Renders the body of a message from a builder's `text`/`html`/`attachments`,
 * returning the `Content-Type` header value and the body to place after the
 * message headers.
 *
 * Empty-string `text`/`html` are treated as absent — many parsers (e.g.
 * `letterparser`) return `html: ""` for a text-only message, and the previous
 * nullish-coalescing selection would then emit an empty `text/html` body.
 *
 * - both `text` and `html` → `multipart/alternative` (plain first, then html)
 * - only one → a single `text/plain` or `text/html` part
 * - `attachments` → the content above wrapped as the first part of a
 *   `multipart/mixed`, followed by the attachment parts
 */
export function renderBodyContent({
	html,
	text,
	attachments,
}: {
	html: string | undefined;
	text: string | undefined;
	attachments: EmailAttachment[] | undefined;
}): RenderedContent {
	const hasHtml = html !== undefined && html.trim().length > 0;
	const hasText = text !== undefined && text.trim().length > 0;

	const plainPart: RenderedContent = {
		contentType: "text/plain; charset=UTF-8",
		body: hasText ? (text as string) : "",
	};
	const htmlPart: RenderedContent = {
		contentType: "text/html; charset=UTF-8",
		body: html as string,
	};

	let content: RenderedContent;
	if (hasHtml && hasText) {
		content = renderMultipart("alternative", [
			renderLeafPart(plainPart),
			renderLeafPart(htmlPart),
		]);
	} else if (hasHtml) {
		content = htmlPart;
	} else {
		content = plainPart;
	}

	if (attachments === undefined || attachments.length === 0) {
		return content;
	}

	return renderMultipart("mixed", [
		renderLeafPart(content),
		...attachments.map(renderAttachment),
	]);
}

function toAddressList(
	value: string | EmailAddress | (string | EmailAddress)[]
): string {
	const array = Array.isArray(value) ? value : [value];
	return array.map(formatEmailAddress).join(", ");
}

/**
 * Synthesizes a complete RFC 5322 `.eml` from a `MessageBuilder`. The
 * `send_email` binding's `MessageBuilder` path never has a real raw message, so
 * we build one here purely so the local explorer preview has something to
 * render. `bcc` recipients receive the message but, as in production, are
 * omitted from the visible headers.
 */
export function renderSendingEml(
	builder: MessageBuilder,
	messageId: string
): string {
	const { body, contentType } = renderBodyContent({
		html: builder.html,
		text: builder.text,
		attachments: builder.attachments,
	});

	const headers: string[] = [
		`From: ${formatEmailAddress(builder.from)}`,
		`To: ${toAddressList(builder.to)}`,
	];

	if (builder.cc !== undefined) {
		headers.push(`Cc: ${toAddressList(builder.cc)}`);
	}

	headers.push(
		`Subject: ${builder.subject}`,
		// `messageId` already includes angle brackets (see `synthesizeMessageId`).
		`Message-ID: ${messageId}`,
		"MIME-Version: 1.0",
		`Content-Type: ${contentType}`
	);

	if (builder.replyTo !== undefined) {
		headers.push(`Reply-To: ${formatEmailAddress(builder.replyTo)}`);
	}

	for (const [key, value] of Object.entries(builder.headers ?? {})) {
		headers.push(`${key}: ${value}`);
	}

	return `${headers.join("\r\n")}\r\n\r\n${body}`;
}
