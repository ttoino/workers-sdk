import { Button, cn, Flow, Text } from "@cloudflare/kumo";
import {
	CaretDownIcon,
	CheckCircleIcon,
	LightningIcon,
	ProhibitIcon,
	QuestionIcon,
	WarningIcon,
	XCircleIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { RESULT_LABEL, resolveResult, type ResultKind } from "./resultLabel";
import type { EmailActivityRecord } from "./types";

// ---------------------------------------------------------------------------
// Result icon — mirrors the shared result vocabulary (`resultLabel`) so the
// flow node's icon + title always agree with the activity-log Result column.
// ---------------------------------------------------------------------------

function EventIcon({ kind }: { kind: ResultKind }) {
	switch (kind) {
		case "delivered":
		case "forwarded":
			return <CheckCircleIcon size={20} className="text-kumo-success" />;
		case "handled":
			return (
				<LightningIcon size={20} weight="fill" className="text-kumo-subtle" />
			);
		case "deliveryFailed":
		case "error":
			return <XCircleIcon size={20} className="text-kumo-danger" />;
		case "dropped":
			return <ProhibitIcon size={20} className="text-kumo-subtle" />;
		case "unknown":
		default:
			return <QuestionIcon size={20} className="text-kumo-subtle" />;
	}
}

function formatDatetime(datetime: string): string {
	const date = new Date(datetime);
	if (Number.isNaN(date.getTime())) {
		return datetime;
	}
	return date.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	});
}

// ---------------------------------------------------------------------------
// Body field rows — only fields that vary across events of the same recipient
// stream. Constants (subject, messageId, from) live in the message header.
// ---------------------------------------------------------------------------

const ROUTING_ACTION_LABEL: Record<string, string> = {
	forward: "Forward",
	worker: "Worker",
	drop: "Drop",
	unknown: "Unknown",
};

function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<span className="text-xs font-semibold tracking-wide text-kumo-subtle uppercase">
				{label}
			</span>
			<span className="text-sm break-words text-kumo-default">{children}</span>
		</div>
	);
}

function ErrorField({ detail }: { detail: string }) {
	return (
		<div className="col-span-2">
			<Field label="Reason">
				<span className="flex items-center gap-2">
					<WarningIcon size={16} className="shrink-0 text-kumo-danger" />
					<Text as="span" variant="error" size="sm">
						{detail}
					</Text>
				</span>
			</Field>
		</div>
	);
}

/**
 * Whether an event has any expandable body content. Routing events always
 * show their Action + Worker; sending events only have a body when they
 * carry an `errorDetail` (the envelope recipient already sits in the header).
 */
function hasBody(event: EmailActivityRecord): boolean {
	return event.direction === "routing" || Boolean(event.errorDetail);
}

function EventBody({ event }: { event: EmailActivityRecord }) {
	return (
		<div className="grid grid-cols-2 gap-4 border-t border-kumo-line px-4 py-3">
			{event.direction === "routing" ? (
				<>
					<Field label="Action">
						{ROUTING_ACTION_LABEL[event.action] ?? event.action}
					</Field>
					<Field label="Worker">{event.worker || "—"}</Field>
				</>
			) : null}
			{event.errorDetail ? <ErrorField detail={event.errorDetail} /> : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// EventNode
// ---------------------------------------------------------------------------

/**
 * One event in a message's lifecycle, rendered as a Kumo `Flow.Node` with an
 * expandable body. The header row (icon + result label + timestamp + chevron)
 * is wrapped in `<Flow.Anchor>` so connector lines always attach to a
 * height-stable element even when the body expands.
 */
export function EventNode({ event }: { event: EmailActivityRecord }) {
	const [open, setOpen] = useState(false);
	const kind = resolveResult({
		status: event.status,
		action: event.direction === "routing" ? event.action : undefined,
	});
	const expandable = hasBody(event);

	return (
		<Flow.Node
			render={
				<li
					data-testid="log-detail-event-node"
					data-result={kind}
					data-status={event.status}
					data-open={open || undefined}
					className={cn(
						"list-none rounded-lg bg-kumo-base shadow-sm ring ring-kumo-hairline",
						"max-w-[420px] min-w-[280px]"
					)}
				>
					<Flow.Anchor
						render={
							<div className="flex min-h-12 items-center gap-3 px-4 py-2">
								<EventIcon kind={kind} />
								<div className="flex min-w-0 flex-1 flex-col">
									<Text as="span" size="sm" bold truncate>
										{RESULT_LABEL[kind]}
									</Text>
									{event.direction === "sending" && event.envelopeTos ? (
										<Text
											as="span"
											size="xs"
											truncate
											data-testid="log-detail-event-envelope-tos"
										>
											{event.envelopeTos}
										</Text>
									) : null}
									<Text as="span" variant="secondary" size="xs">
										{formatDatetime(event.datetime)}
									</Text>
								</div>
								{expandable ? (
									<Button
										variant="ghost"
										size="sm"
										onClick={() => setOpen((prev) => !prev)}
										aria-expanded={open}
										aria-label={open ? "Collapse" : "Expand"}
									>
										<CaretDownIcon
											size={16}
											className={cn(
												"transition-transform",
												open && "rotate-180"
											)}
										/>
									</Button>
								) : null}
							</div>
						}
					/>
					{expandable && open ? (
						<div data-testid="log-detail-event-body">
							<EventBody event={event} />
						</div>
					) : null}
				</li>
			}
		/>
	);
}
