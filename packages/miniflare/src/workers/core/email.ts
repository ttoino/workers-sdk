import assert from "node:assert";
import { $, blue, red, reset, yellow } from "kleur/colors";
import { LogLevel, SharedHeaders } from "miniflare:shared";
import PostalMime from "postal-mime";
import { RAW_EMAIL } from "../email/constants";
import { encodeBase64 } from "../email/mime";
import { isEmailReplyable, validateReply } from "../email/validate";
import { CoreBindings } from "./constants";
import type { MiniflareEmailMessage } from "../email/email.worker";
import type { EmailActivityInput, RoutingStatus } from "../email/types";
import type { ForwardableEmailMessage } from "@cloudflare/workers-types/experimental";
import type { Email } from "postal-mime";

// Force-enable colours, because kleur can't detect this setting correctly from within a Worker
// The user setting should be respected (and ansi stripped out if needed) in https://github.com/cloudflare/workers-sdk/blob/2529848e9ff3ddb01ac8c73f96747f32b47aca3e/packages/miniflare/src/index.ts#L993
$.enabled = true;

type Env = {
	[CoreBindings.SERVICE_LOOPBACK]: Fetcher;
};

function renderEmailHeaders(headers: Headers | undefined) {
	return headers
		? `\n  headers:\n${[...headers.entries()].map(([k, v]) => `    ${k}: ${v}`).join("\n")}`
		: "";
}

/**
 * Persists a batch of email activity events for the local explorer via the
 * loopback endpoint (which assigns `id`/`datetime` and computes `isLastEvent`).
 * Best-effort: failures are swallowed so activity logging never affects email
 * handling.
 */
async function recordEmailActivity(
	env: Env,
	worker: string,
	events: EmailActivityInput[]
): Promise<void> {
	if (events.length === 0) {
		return;
	}

	try {
		await env[CoreBindings.SERVICE_LOOPBACK].fetch(
			`http://localhost/core/email-activity/${encodeURIComponent(worker)}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(events),
			}
		);
	} catch {
		// Activity logging is best-effort and must not affect email delivery.
	}
}

/**
 * Narrows a `reply()` argument to a raw `EmailMessage`. The builder-style
 * overload (`EmailReplyMessageBuilder`) is not supported locally; a real
 * `EmailMessage` is distinguished by carrying the raw-email stream.
 */
function assertIsMiniflareEmailMessage(
	message: unknown
): asserts message is MiniflareEmailMessage {
	assert(
		typeof message === "object" && message !== null && RAW_EMAIL in message,
		"EmailReplyMessageBuilder is not currently supported"
	);
}

export async function handleEmail(
	params: URLSearchParams,
	request: Request,
	service: Fetcher,
	env: Env,
	ctx: ExecutionContext,
	/**
	 * Name of the Worker handling this email, used to scope the local explorer
	 * activity log. When omitted, activity is not recorded.
	 */
	worker?: string
): Promise<Response> {
	// Turn an HTTP request into an EmailMessage, using:
	//  - `from` and `to` from the URL
	//    - These refer to the SMTP envelope addresses: https://datatracker.ietf.org/doc/html/rfc5321#section-3
	//  - `raw` from the request body
	//  - `headers` from the request headers
	// Refer to https://developers.cloudflare.com/email-routing/email-workers/runtime-api/#emailmessage-definition for more details
	const from = params.get("from");
	const to = params.get("to");

	if (!request.body || !from || !to) {
		return new Response(
			"Invalid email. Your request must include URL parameters specifying the `from` and `to` addresses, as well as an email in the body",
			{
				status: 400,
			}
		);
	}
	// We need to parse the email body in this handler in order to validate it, but we also want to pass through
	// the raw email to the user Worker. As such, clone the request for use in this handler.
	const clonedRequest = request.clone();

	assert(clonedRequest.body !== null, "Cloned request body is null");

	const incomingEmailRaw = new Uint8Array(await request.arrayBuffer());

	// Email Routing does not support messages bigger than 25Mib: https://developers.cloudflare.com/email-routing/limits/#message-size
	// In practice, local dev only supports 1MB, since it uses a JSRPC transport.
	if (incomingEmailRaw.byteLength > 25 * 1024 * 1024) {
		return new Response(
			"Email message size is bigger than the production size limit of 25MiB. Local development has a lower limit of 1Mib.",
			{
				status: 400,
			}
		);
	}
	if (incomingEmailRaw.byteLength > 1024 * 1024) {
		return new Response(
			"Email message size is within the production size limit of 25MiB, but exceeds the lower 1Mib limit for testing locally.",
			{
				status: 400,
			}
		);
	}

	let parsedIncomingEmail: Email;
	try {
		parsedIncomingEmail = await PostalMime.parse(incomingEmailRaw);
	} catch (e) {
		const error = e as Error;
		return new Response(
			`Email could not be parsed: ${error.name}: ${error.message}`,
			{ status: 400 }
		);
	}

	if (parsedIncomingEmail.messageId === undefined) {
		return new Response(
			"Email could not be parsed: invalid or no message id provided",
			{ status: 400 }
		);
	}

	// Emails can contain both an "envelope" from/to and a "header" from/to. Warn if these are different.
	// Refer to https://datatracker.ietf.org/doc/html/rfc5321#section-3, https://datatracker.ietf.org/doc/html/rfc5322#section-3.6.2, and https://datatracker.ietf.org/doc/html/rfc5322#section-3.6.3 for more details
	if (from !== parsedIncomingEmail.from.address) {
		await env[CoreBindings.SERVICE_LOOPBACK].fetch(
			"http://localhost/core/log",
			{
				method: "POST",
				headers: { [SharedHeaders.LOG_LEVEL]: LogLevel.WARN.toString() },
				body: `${yellow("Provided MAIL FROM address doesn't match the email message's \"From\" header")}:\n  MAIL FROM: ${from}\n  "From" header: ${parsedIncomingEmail.from.address}`,
			}
		);
	}

	if (!parsedIncomingEmail.to?.map((addr) => addr.address).includes(to)) {
		await env[CoreBindings.SERVICE_LOOPBACK].fetch(
			"http://localhost/core/log",
			{
				method: "POST",
				headers: { [SharedHeaders.LOG_LEVEL]: LogLevel.WARN.toString() },
				body: `${yellow('Provided RCPT TO address doesn\'t match any "To" header in the email message')}:\n  RCPT TO: ${to}\n  "To" header: ${parsedIncomingEmail.to?.map((addr) => addr.address).join(", ")}`,
			}
		);
	}

	const incomingEmailHeaders = new Headers(
		parsedIncomingEmail.headers.map((header) => [header.key, header.value])
	);

	// Propogate `.setReject()` reasons to the caller
	let maybeClientError: string | undefined = undefined;

	// Collected worker-initiated events for the local explorer activity log.
	// Each `forward()` shares the incoming message's id; each `reply()` is a new
	// message with its own id.
	const incomingMessageId = parsedIncomingEmail.messageId;
	const incomingSubject = parsedIncomingEmail.subject ?? "";
	// We only need the count of forwards: every forward row keeps the original
	// incoming envelope recipient as its `to` (the forward destination lives in
	// the console log, not the local activity record).
	let forwardCount = 0;
	const replyEvents: { to: string; messageId: string; rawBase64: string }[] =
		[];
	let handlerError: string | undefined = undefined;

	try {
		// @ts-expect-error .email is not in the `Fetcher` but it's a valid RPC call.
		await service.email(
			// Construct a ForwardableEmailMessage-like object. We need
			// - ForwardableEmailMessage to be able to be passed across JSRPC (to support e.g. userWorker.email(ForwardableEmailMessage))
			// - ForwardableEmailMessage properties to be synchronously available (to match production). This rules out a class extending `RpcStub`
			// However, unlike EmailMessage (see email.worker.ts) it doesn't need to be user-constructable, and so we can just use an object with `satisfies`
			{
				from,
				to,
				raw: clonedRequest.body,
				rawSize: incomingEmailRaw.byteLength,
				headers: incomingEmailHeaders,
				setReject: (reason: string): void => {
					ctx.waitUntil(
						env[CoreBindings.SERVICE_LOOPBACK].fetch(
							"http://localhost/core/log",
							{
								method: "POST",
								headers: {
									[SharedHeaders.LOG_LEVEL]: LogLevel.ERROR.toString(),
								},
								body: `${red("Email handler rejected message")}${reset(` with the following reason: "${reason}"`)}`,
							}
						)
					);
					maybeClientError = reason;
				},
				forward: async (
					rcptTo: string,
					headers?: Headers
				): Promise<EmailSendResult> => {
					await env[CoreBindings.SERVICE_LOOPBACK].fetch(
						"http://localhost/core/log",
						{
							method: "POST",
							headers: { [SharedHeaders.LOG_LEVEL]: LogLevel.INFO.toString() },
							body: `${blue("Email handler forwarded message")}${reset(` with\n  rcptTo: ${rcptTo}${renderEmailHeaders(headers)}`)}`,
						}
					);
					// Each forward is a distinct delivery event sharing the incoming
					// message's id (matches production `emailRoutingAdaptive`).
					forwardCount++;
					/**
					 * The message ID in production is a 36 character random string that identifies the message for e.g. linking up threads.
					 * In production it uses the sender domain rather than example.com. Locally, we have access to none of that information
					 * so instead we make a dummy message ID that matches the production format (36 characters followed by a domain)
					 */
					const uuid = crypto.randomUUID().replaceAll("-", "");
					return { messageId: `${uuid}@example.com` };
				},
				reply: async (replyMessage): Promise<EmailSendResult> => {
					assertIsMiniflareEmailMessage(replyMessage);

					if (
						!(await isEmailReplyable(
							parsedIncomingEmail,
							incomingEmailHeaders,
							async (msg) =>
								void (await env[CoreBindings.SERVICE_LOOPBACK].fetch(
									"http://localhost/core/log",
									{
										method: "POST",
										headers: {
											[SharedHeaders.LOG_LEVEL]: LogLevel.ERROR.toString(),
										},
										body: msg,
									}
								))
						))
					) {
						throw new Error("Original email is not replyable");
					}
					const finalReply = await validateReply(
						parsedIncomingEmail,
						replyMessage
					);

					const finalReplyRaw = new Uint8Array(
						await new Response(finalReply).arrayBuffer()
					);

					const resp = await env[CoreBindings.SERVICE_LOOPBACK].fetch(
						"http://localhost/core/store-temp-file?extension=eml&prefix=email",
						{
							method: "POST",
							body: finalReplyRaw,
						}
					);
					const file = await resp.text();

					await env[CoreBindings.SERVICE_LOOPBACK].fetch(
						"http://localhost/core/log",
						{
							method: "POST",
							headers: { [SharedHeaders.LOG_LEVEL]: LogLevel.INFO.toString() },
							body: `${blue("Email handler replied to sender")}${reset(` with the following message:\n  ${file}`)}`,
						}
					);

					/**
					 * The message ID in production is a 36 character random string that identifies the message for e.g. linking up threads.
					 * In production it uses the sender domain rather than example.com. Locally, we have access to none of that information
					 * so instead we make a dummy message ID that matches the production format (36 characters followed by a domain)
					 */
					const uuid = crypto.randomUUID().replaceAll("-", "");
					const replyMessageId = `${uuid}@example.com`;
					// A reply is a new outbound message with its own id, delivered
					// back to the original sender.
					replyEvents.push({
						to: parsedIncomingEmail.from.address ?? from,
						messageId: replyMessageId,
						rawBase64: encodeBase64(finalReplyRaw),
					});
					return { messageId: replyMessageId };
				},
			} satisfies ForwardableEmailMessage
		);
	} catch (e) {
		handlerError = e instanceof Error ? e.message : String(e);
	}

	// Record activity for the local explorer, mirroring the production
	// `emailRoutingAdaptive` schema: one row for the worker's handling outcome,
	// one row per forward (sharing the incoming message id), and one row per
	// reply (each a new message id).
	if (worker !== undefined) {
		const events: EmailActivityInput[] = [];

		// The worker-handling row. Its status reflects how the worker disposed
		// of the incoming message.
		let workerStatus: RoutingStatus;
		if (handlerError !== undefined) {
			workerStatus = "error";
		} else if (maybeClientError !== undefined) {
			workerStatus = "deliveryFailed";
		} else {
			workerStatus = "dropped";
		}
		events.push({
			direction: "routing",
			action: "worker",
			worker,
			messageId: incomingMessageId,
			from,
			to,
			subject: incomingSubject,
			status: workerStatus,
			errorDetail: handlerError ?? maybeClientError,
			isNDR: 0,
			isLastEvent: 0,
			rawBase64: encodeBase64(incomingEmailRaw),
		});

		// One delivered row per forward, sharing the incoming message id. Each
		// keeps the original incoming envelope recipient as its `to`.
		for (let i = 0; i < forwardCount; i++) {
			events.push({
				direction: "routing",
				action: "unknown",
				worker,
				messageId: incomingMessageId,
				from,
				to,
				subject: incomingSubject,
				status: "delivered",
				isNDR: 0,
				isLastEvent: 0,
			});
		}

		// One delivered row per reply, each a new outbound message id.
		for (const replyEvent of replyEvents) {
			events.push({
				direction: "routing",
				action: "unknown",
				worker,
				messageId: replyEvent.messageId,
				from: to,
				to: replyEvent.to,
				subject: incomingSubject,
				status: "delivered",
				isNDR: 0,
				isLastEvent: 0,
				rawBase64: replyEvent.rawBase64,
			});
		}

		ctx.waitUntil(recordEmailActivity(env, worker, events));
	}

	if (handlerError !== undefined) {
		return new Response(
			`Worker threw an error while processing email: ${handlerError}`,
			{ status: 500 }
		);
	}

	if (maybeClientError !== undefined) {
		return new Response(
			`Worker rejected email with the following reason: ${maybeClientError}`,
			{ status: 400 }
		);
	}

	return new Response("Worker successfully processed email", {
		status: 200,
	});
}
