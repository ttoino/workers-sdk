import {
	Banner,
	Button,
	Dialog,
	Input,
	InputGroup,
	Label,
	Tabs,
	Text,
	Textarea,
} from "@cloudflare/kumo";
import { useState } from "react";
import { emailSendTest } from "../../api";

const MAX_BYTES = 1024 * 1024;

type Mode = "builder" | "raw";

/** Formats an address as `"Name" <email>` when a display name is given. */
function formatAddress(name: string, email: string): string {
	const trimmedName = name.trim();
	const trimmedEmail = email.trim();
	return trimmedName ? `"${trimmedName}" <${trimmedEmail}>` : trimmedEmail;
}

/** Build a minimal RFC 5322 message from the builder fields. */
function buildRawMessage(opts: {
	from: string;
	to: string;
	subject: string;
	body: string;
}): string {
	const messageId = `<${crypto.randomUUID()}@miniflare.local>`;
	return [
		`From: ${opts.from}`,
		`To: ${opts.to}`,
		`Subject: ${opts.subject}`,
		`Message-ID: ${messageId}`,
		`Date: ${new Date().toUTCString()}`,
		"MIME-Version: 1.0",
		'Content-Type: text/plain; charset="utf-8"',
		"",
		opts.body,
	].join("\r\n");
}

const MODE_TABS = [
	{ value: "builder", label: "Builder" },
	{ value: "raw", label: "Raw" },
];

/**
 * Dispatches a test email to a Worker through the entry service's inbound email
 * path, exercising the real routing handler (and thus activity logging). Offers
 * a builder form (named from/to plus subject/body) or a raw `.eml` paste; both
 * enforce the local 1 MiB message cap. The envelope addresses are derived from
 * the message's own From/To headers server-side.
 */
export function SendTestDialog({
	worker,
	open,
	onOpenChange,
	onSent,
}: {
	worker: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSent: () => void;
}) {
	const [mode, setMode] = useState<Mode>("builder");
	const [fromName, setFromName] = useState("");
	const [fromEmail, setFromEmail] = useState("sender@example.com");
	const [toName, setToName] = useState("");
	const [toEmail, setToEmail] = useState("someone@example.com");
	const [subject, setSubject] = useState("Test message");
	const [body, setBody] = useState("Hello from the local explorer.");
	const [raw, setRaw] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function reset() {
		setError(null);
		setSending(false);
	}

	async function handleSend() {
		setError(null);

		let message: string;
		if (mode === "builder") {
			if (!fromEmail.trim() || !toEmail.trim()) {
				setError("Both a sender and recipient address are required.");
				return;
			}
			message = buildRawMessage({
				from: formatAddress(fromName, fromEmail),
				to: formatAddress(toName, toEmail),
				subject,
				body,
			});
		} else {
			if (!raw.trim()) {
				setError("Paste a raw .eml message, or switch to the builder.");
				return;
			}
			message = raw;
		}

		if (new TextEncoder().encode(message).byteLength > MAX_BYTES) {
			setError("Message exceeds the local 1 MiB limit.");
			return;
		}

		setSending(true);
		try {
			const response = await emailSendTest({
				path: { worker },
				body: { raw: message },
				throwOnError: false,
			});
			if (response.error) {
				setError(
					response.error.errors?.[0]?.message ?? "Failed to send test email."
				);
				return;
			}
			onOpenChange(false);
			onSent();
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to send test email."
			);
		} finally {
			setSending(false);
		}
	}

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) {
					reset();
				}
			}}
		>
			<Dialog size="lg" className="w-lg">
				<div className="border-b border-kumo-fill px-6 py-4">
					{/* @ts-expect-error - Type mismatch due to pnpm monorepo @types/react version conflict */}
					<Dialog.Title>
						<Text as="span" variant="heading3">
							Send test email
						</Text>
					</Dialog.Title>
					<div className="mt-1">
						<Text variant="secondary" size="sm">
							Delivers an inbound message to{" "}
							<Text as="span" bold>
								{worker}
							</Text>
							, running its email handler.
						</Text>
					</div>
				</div>

				<div className="space-y-4 px-6 py-5">
					{error ? <Banner variant="error" description={error} /> : null}

					<Tabs
						variant="segmented"
						tabs={MODE_TABS}
						value={mode}
						onValueChange={(value) =>
							setMode(value === "raw" ? "raw" : "builder")
						}
					/>

					{mode === "builder" ? (
						<>
							<div className="grid grid-cols-2 gap-4">
								<div>
									<Label className="mb-2 block">From</Label>
									<InputGroup size="base">
										<InputGroup.Input
											aria-label="Sender name"
											// @ts-expect-error - Type mismatch due to pnpm monorepo @types/react version conflict
											value={fromName}
											onValueChange={setFromName}
											placeholder="Name (optional)"
										/>
										<InputGroup.Input
											aria-label="Sender email"
											// @ts-expect-error - Type mismatch due to pnpm monorepo @types/react version conflict
											value={fromEmail}
											onValueChange={setFromEmail}
											placeholder="sender@example.com"
										/>
									</InputGroup>
								</div>
								<div>
									<Label className="mb-2 block">To</Label>
									<InputGroup size="base">
										<InputGroup.Input
											aria-label="Recipient name"
											// @ts-expect-error - Type mismatch due to pnpm monorepo @types/react version conflict
											value={toName}
											onValueChange={setToName}
											placeholder="Name (optional)"
										/>
										<InputGroup.Input
											aria-label="Recipient email"
											// @ts-expect-error - Type mismatch due to pnpm monorepo @types/react version conflict
											value={toEmail}
											onValueChange={setToEmail}
											placeholder="recipient@example.com"
										/>
									</InputGroup>
								</div>
							</div>
							<Input
								label="Subject"
								// @ts-expect-error - Type mismatch due to pnpm monorepo @types/react version conflict
								value={subject}
								onValueChange={setSubject}
							/>
							<Textarea
								label="Body"
								className="resize-y font-mono"
								rows={6}
								value={body}
								onValueChange={setBody}
							/>
						</>
					) : (
						<Textarea
							label="Raw message (.eml)"
							className="resize-y font-mono"
							rows={12}
							value={raw}
							onValueChange={setRaw}
							placeholder={
								"From: sender@example.com\r\nTo: recipient@example.com\r\nSubject: ...\r\n\r\nBody"
							}
						/>
					)}
				</div>

				<div className="flex justify-end gap-2 border-t border-kumo-fill px-6 py-4">
					<Button
						variant="secondary"
						onClick={() => onOpenChange(false)}
						disabled={sending}
					>
						Cancel
					</Button>
					<Button
						variant="primary"
						loading={sending}
						disabled={sending}
						onClick={() => void handleSend()}
					>
						Send
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
