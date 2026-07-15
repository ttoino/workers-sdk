import {
	Button,
	Dialog,
	Empty,
	LayerCard,
	Loader,
	Table,
	Tabs,
} from "@cloudflare/kumo";
import {
	ArrowsOutIcon,
	ArrowSquareOutIcon,
	EnvelopeIcon,
	XIcon,
} from "@phosphor-icons/react";
import PostalMime, { type Email } from "postal-mime";
import prettyBytes from "pretty-bytes";
import { useEffect, useMemo, useState } from "react";
import { emailGetRaw } from "../../api";
import { CopyButton } from "../CopyButton";
import {
	attachmentByteSize,
	attachmentDataUrl,
	buildInlineImageMap,
	getDownloadableAttachments,
	inlineCidImages,
	sanitizeEmailHtml,
} from "./messagePreview";
import type { TabsItem } from "@cloudflare/kumo";

type PreviewTab = "html" | "text" | "headers" | "attachments" | "raw";

function isPreviewTab(value: string): value is PreviewTab {
	return (
		value === "html" ||
		value === "text" ||
		value === "headers" ||
		value === "attachments" ||
		value === "raw"
	);
}

/** Escape a string for safe interpolation into an HTML document `<title>`. */
function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Wrap sanitized body HTML in a minimal document for iframe / new-tab use. */
function wrapDocument(bodyHtml: string, title: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><base target="_blank"><title>${escapeHtml(title)}</title></head><body>${bodyHtml}</body></html>`;
}

function CodeBlock({ content }: { content: string }) {
	return (
		<div className="group/cell relative">
			<div className="absolute top-2 right-2 z-10">
				<CopyButton text={content} />
			</div>
			<pre className="max-h-[32rem] overflow-auto px-4 py-3 font-mono text-xs whitespace-pre-wrap text-kumo-default">
				{content}
			</pre>
		</div>
	);
}

function PreviewShell({ children }: { children: React.ReactNode }) {
	return (
		<LayerCard>
			<LayerCard.Secondary>Message preview</LayerCard.Secondary>
			{/* @ts-expect-error - Type mismatch due to pnpm monorepo @types/react version conflict */}
			<LayerCard.Primary>{children}</LayerCard.Primary>
		</LayerCard>
	);
}

interface PreviewState {
	status: "loading" | "ready" | "not-available" | "error";
	raw: string;
	email: Email | null;
	errorMessage: string;
}

/**
 * A rendered preview of a message's raw `.eml`, fetched by `messageId` and
 * parsed with `postal-mime`. Shown across tabs: rendered HTML body (sandboxed
 * iframe + native Sanitizer when available, inline `cid:` images spliced in),
 * plaintext body, headers, downloadable attachments, and the raw MIME source.
 *
 * A 404 from the raw endpoint means the message has no stored body (e.g. a
 * forward event) — surfaced as a calm informational state, never an error.
 */
export function PreviewCard({
	worker,
	messageId,
}: {
	worker: string;
	messageId: string;
}) {
	const [state, setState] = useState<PreviewState>({
		status: "loading",
		raw: "",
		email: null,
		errorMessage: "",
	});
	const [activeTab, setActiveTab] = useState<PreviewTab>("html");

	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading", raw: "", email: null, errorMessage: "" });

		void (async () => {
			try {
				const response = await emailGetRaw({
					path: { worker },
					query: { messageId },
					parseAs: "text",
					throwOnError: false,
				});

				if (cancelled) {
					return;
				}

				if (response.response?.status === 404) {
					setState((s) => ({ ...s, status: "not-available" }));
					return;
				}
				if (response.error || typeof response.data !== "string") {
					setState((s) => ({
						...s,
						status: "error",
						errorMessage: "Failed to load the raw message.",
					}));
					return;
				}

				const raw = response.data;
				const email = await PostalMime.parse(raw, {
					attachmentEncoding: "base64",
				});
				if (!cancelled) {
					setState({ status: "ready", raw, email, errorMessage: "" });
				}
			} catch {
				if (!cancelled) {
					setState((s) => ({
						...s,
						status: "error",
						errorMessage: "Failed to parse the message.",
					}));
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [worker, messageId]);

	const email = state.email;
	const htmlBody = email?.html ?? "";
	const cidMap = useMemo(
		() => buildInlineImageMap(email?.attachments),
		[email]
	);
	const { html: safeHtml, sanitized } = useMemo(
		() =>
			htmlBody
				? sanitizeEmailHtml(inlineCidImages(htmlBody, cidMap))
				: { html: "", sanitized: false },
		[htmlBody, cidMap]
	);

	if (state.status === "loading") {
		return (
			<PreviewShell>
				<div className="flex justify-center py-8">
					<Loader />
				</div>
			</PreviewShell>
		);
	}

	if (state.status === "not-available") {
		return (
			<PreviewShell>
				<Empty
					icon={<EnvelopeIcon size={48} />}
					title="Preview not available"
					description="This event has no stored message body — for example, a forwarded message keeps no local copy."
				/>
			</PreviewShell>
		);
	}

	if (state.status === "error") {
		return (
			<PreviewShell>
				<Empty
					icon={<EnvelopeIcon size={48} />}
					title="Could not render preview"
					description={state.errorMessage}
				/>
			</PreviewShell>
		);
	}

	const raw = state.raw;
	const textBody = email?.text ?? "";
	const hasHtml = htmlBody.length > 0;
	const hasText = textBody.length > 0;
	const headers = email?.headers ?? [];
	const attachments = getDownloadableAttachments(email?.attachments);
	const hasHeaders = headers.length > 0;
	const hasAttachments = attachments.length > 0;

	const tabs: TabsItem[] = [
		...(hasHtml ? [{ value: "html", label: "HTML" }] : []),
		...(hasText ? [{ value: "text", label: "Text" }] : []),
		...(hasHeaders ? [{ value: "headers", label: "Headers" }] : []),
		...(hasAttachments ? [{ value: "attachments", label: "Attachments" }] : []),
		{ value: "raw", label: "Raw" },
	];

	// Fall back to the first available tab if the persisted selection isn't
	// present for this message. Precedence matches tab order.
	const effectiveTab: PreviewTab = tabs.some((tab) => tab.value === activeTab)
		? activeTab
		: hasHtml
			? "html"
			: hasText
				? "text"
				: hasHeaders
					? "headers"
					: hasAttachments
						? "attachments"
						: "raw";

	const previewTitle = email?.subject?.trim() || "Message preview";
	const iframeDoc = wrapDocument(safeHtml, previewTitle);

	const openInNewTab = () => {
		const url = URL.createObjectURL(
			new Blob([iframeDoc], { type: "text/html" })
		);
		window.open(url, "_blank", "noopener,noreferrer");
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	};

	const isHtmlTab = effectiveTab === "html";

	return (
		<LayerCard>
			<LayerCard.Secondary className="flex flex-wrap items-center justify-between gap-3">
				Message preview
				<div className="flex items-center gap-2">
					{isHtmlTab ? (
						<>
							<Dialog.Root>
								<Dialog.Trigger
									render={
										<Button
											variant="secondary"
											size="sm"
											shape="square"
											aria-label="Expand preview"
										>
											<ArrowsOutIcon size={16} />
										</Button>
									}
								/>
								<Dialog className="flex h-[90vh] max-h-[calc(100vh-64px)] flex-col p-0 sm:w-[min(90vw,72rem)]">
									<div className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
										{/* @ts-expect-error - Type mismatch due to pnpm monorepo @types/react version conflict */}
										<Dialog.Title>{previewTitle}</Dialog.Title>
										<Dialog.Close
											// @ts-expect-error - Type mismatch due to pnpm monorepo @types/react version conflict
											render={
												<Button
													aria-label="Close"
													shape="square"
													size="sm"
													variant="ghost"
												>
													<XIcon size={16} />
												</Button>
											}
										/>
									</div>
									<div className="min-h-0 flex-1">
										<iframe
											sandbox=""
											title={previewTitle}
											srcDoc={iframeDoc}
											className="m-0 h-full w-full border-none"
										/>
									</div>
								</Dialog>
							</Dialog.Root>
							{sanitized ? (
								<Button
									variant="secondary"
									size="sm"
									shape="square"
									aria-label="Open in new tab"
									onClick={openInNewTab}
								>
									<ArrowSquareOutIcon size={16} />
								</Button>
							) : null}
						</>
					) : null}
					<Tabs
						variant="segmented"
						tabs={tabs}
						value={effectiveTab}
						onValueChange={(value) => {
							if (isPreviewTab(value)) {
								setActiveTab(value);
							}
						}}
					/>
				</div>
			</LayerCard.Secondary>
			<LayerCard.Primary className="p-0">
				{isHtmlTab ? (
					<iframe
						data-testid="preview-frame"
						sandbox=""
						title={previewTitle}
						srcDoc={iframeDoc}
						className="m-0 aspect-video w-full border-none"
					/>
				) : null}
				{effectiveTab === "text" ? <CodeBlock content={textBody} /> : null}
				{effectiveTab === "headers" ? (
					<div className="max-h-[32rem] overflow-auto">
						<Table>
							<Table.Body>
								{headers.map((header, index) => (
									<Table.Row key={`${header.key}-${index}`}>
										<Table.Cell className="align-top font-mono text-xs whitespace-nowrap text-kumo-subtle">
											{header.key}
										</Table.Cell>
										<Table.Cell className="align-top font-mono text-xs break-all whitespace-pre-wrap">
											{header.value}
										</Table.Cell>
									</Table.Row>
								))}
							</Table.Body>
						</Table>
					</div>
				) : null}
				{effectiveTab === "attachments" ? (
					<div className="max-h-[32rem] overflow-auto">
						<Table>
							<Table.Body>
								{attachments.map((attachment, index) => (
									<Table.Row
										key={`${attachment.filename ?? "attachment"}-${index}`}
									>
										<Table.Cell className="align-top font-mono text-xs">
											<a
												href={attachmentDataUrl(attachment)}
												download={attachment.filename ?? "attachment"}
												className="break-all text-kumo-link hover:underline"
											>
												{attachment.filename ?? "—"}
											</a>
										</Table.Cell>
										<Table.Cell className="align-top font-mono text-xs break-all text-kumo-subtle">
											{attachment.mimeType}
										</Table.Cell>
										<Table.Cell className="align-top font-mono text-xs whitespace-nowrap text-kumo-subtle">
											{prettyBytes(attachmentByteSize(attachment))}
										</Table.Cell>
									</Table.Row>
								))}
							</Table.Body>
						</Table>
					</div>
				) : null}
				{effectiveTab === "raw" ? <CodeBlock content={raw} /> : null}
			</LayerCard.Primary>
		</LayerCard>
	);
}
