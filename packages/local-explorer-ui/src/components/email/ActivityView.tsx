import { Banner, Button, Dialog, Empty, Text } from "@cloudflare/kumo";
import {
	ArrowsClockwiseIcon,
	EnvelopeIcon,
	PaperPlaneTiltIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	emailDeleteActivity,
	emailListRoutingActivity,
	emailListSendingActivity,
} from "../../api";
import EmailIcon from "../../assets/icons/email.svg?react";
import { withMinimumDelay } from "../../utils/async";
import { Breadcrumbs } from "../Breadcrumbs";
import { ResultBadge } from "./ResultBadge";
import { resolveResult } from "./resultLabel";
import { SendTestDialog } from "./SendTestDialog";
import { useSelectedWorkerName } from "./useSelectedWorker";
import type { EmailActivityRecord, EmailDirection } from "./types";

function formatTime(datetime: string): string {
	const date = new Date(datetime);
	if (Number.isNaN(date.getTime())) {
		return datetime;
	}
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		second: "2-digit",
	});
}

async function fetchActivity(
	worker: string,
	direction: EmailDirection
): Promise<EmailActivityRecord[]> {
	if (direction === "routing") {
		const response = await emailListRoutingActivity({ path: { worker } });
		return response.data?.result ?? [];
	}
	const response = await emailListSendingActivity({ path: { worker } });
	return response.data?.result ?? [];
}

/**
 * The email activity log for one direction (routing or sending) of the selected
 * Worker. Rows are newest-first; clicking one opens its message lifecycle.
 * Routing additionally offers "Send test email", which dispatches an inbound
 * message through the Worker's email handler.
 */
export function ActivityView({ direction }: { direction: EmailDirection }) {
	const worker = useSelectedWorkerName();
	const navigate = useNavigate();

	const [records, setRecords] = useState<EmailActivityRecord[]>([]);
	const [initialLoad, setInitialLoad] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sendOpen, setSendOpen] = useState(false);

	const load = useCallback(
		async (quiet?: boolean) => {
			if (!worker) {
				setRecords([]);
				setInitialLoad(false);
				return;
			}
			try {
				setError(null);
				const result = await fetchActivity(worker, direction);
				setRecords(result);
			} catch (err) {
				setError(
					err instanceof Error ? err.message : "Failed to load email activity."
				);
			} finally {
				if (!quiet) {
					setInitialLoad(false);
				}
			}
		},
		[worker, direction]
	);

	useEffect(() => {
		setInitialLoad(true);
		void load();
	}, [load]);

	// Quiet auto-poll every 10s.
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	useEffect(() => {
		pollRef.current = setInterval(() => void load(true), 10_000);
		return () => {
			if (pollRef.current) {
				clearInterval(pollRef.current);
			}
		};
	}, [load]);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			await withMinimumDelay(load(true));
		} finally {
			setRefreshing(false);
		}
	}, [load]);

	async function handleDeleteAll() {
		if (!worker) {
			return;
		}
		await emailDeleteActivity({ path: { worker } });
		void load();
	}

	function openDetail(record: EmailActivityRecord) {
		void navigate({
			to: direction === "routing" ? "/email/routing/$id" : "/email/sending/$id",
			params: { id: record.id },
			search: (prev) => prev,
		});
	}

	const recipientHeader = direction === "routing" ? "To" : "Recipient";

	return (
		<>
			<Breadcrumbs
				icon={EmailIcon}
				items={[direction === "routing" ? "Routing" : "Sending"]}
				title="Email"
			/>

			<div className="px-8 py-6">
				<div className="mb-4 flex items-center justify-end">
					<div className="flex items-center gap-2">
						{direction === "routing" ? (
							<Button variant="primary" onClick={() => setSendOpen(true)}>
								<PaperPlaneTiltIcon size={14} weight="fill" />
								Send test email
							</Button>
						) : null}
						<Button
							aria-label="Refresh"
							disabled={refreshing}
							onClick={() => void handleRefresh()}
							shape="square"
							variant="secondary"
						>
							<ArrowsClockwiseIcon
								size={18}
								className={refreshing ? "animate-spin" : ""}
							/>
						</Button>
						<Dialog.Root role="alertdialog">
							<Dialog.Trigger
								render={
									<Button
										aria-label="Clear activity"
										disabled={records.length === 0}
										shape="square"
										variant="secondary"
									>
										<TrashIcon size={16} className="text-kumo-danger" />
									</Button>
								}
							/>
							<Dialog size="sm">
								<div className="border-b border-kumo-fill px-6 py-4">
									{/* @ts-expect-error - Type mismatch due to pnpm monorepo @types/react version conflict */}
									<Dialog.Title>
										<Text as="span" variant="heading3">
											Clear activity log?
										</Text>
									</Dialog.Title>
									<div className="mt-1">
										<Text variant="secondary" size="sm">
											This permanently removes all locally-recorded{" "}
											{direction === "routing" ? "inbound" : "outbound"} email
											activity for this Worker. This can't be undone.
										</Text>
									</div>
								</div>
								<div className="flex justify-end gap-2 border-t border-kumo-fill px-6 py-4">
									<Dialog.Close
										// @ts-expect-error - Type mismatch due to pnpm monorepo @types/react version conflict
										render={<Button variant="secondary">Cancel</Button>}
									/>
									<Dialog.Close
										// @ts-expect-error - Type mismatch due to pnpm monorepo @types/react version conflict
										render={
											<Button
												variant="destructive"
												onClick={() => void handleDeleteAll()}
											>
												Clear
											</Button>
										}
									/>
								</div>
							</Dialog>
						</Dialog.Root>
					</div>
				</div>

				{error ? (
					<Banner variant="error" description={error} className="mb-4" />
				) : null}

				{initialLoad ? (
					<div className="p-12 text-center">
						<Text variant="secondary">Loading...</Text>
					</div>
				) : records.length === 0 ? (
					<Empty
						icon={<EnvelopeIcon size={48} />}
						title="No email activity yet."
						description={
							direction === "routing"
								? "Inbound messages handled by this Worker will appear here."
								: "Outbound messages sent by this Worker will appear here."
						}
					/>
				) : (
					<div className="overflow-hidden rounded-lg border border-kumo-fill bg-kumo-base">
						<div className="grid grid-cols-5 gap-3 border-b border-kumo-fill px-4 py-2 text-xs font-semibold tracking-wide text-kumo-subtle uppercase">
							<span>Subject</span>
							<span>From</span>
							<span>{recipientHeader}</span>
							<span>Time</span>
							<span>Result</span>
						</div>
						{records.map((record) => (
							<button
								key={record.id}
								type="button"
								onClick={() => openDetail(record)}
								className="grid w-full grid-cols-5 items-center gap-3 border-b border-kumo-fill px-4 py-2.5 text-left transition-colors last:border-b-0 hover:bg-kumo-fill"
							>
								<Text as="span" size="sm" truncate>
									{record.subject || "—"}
								</Text>
								<Text as="span" size="sm" truncate>
									{record.from || "—"}
								</Text>
								<Text as="span" size="sm" truncate>
									{record.direction === "routing"
										? record.to
										: record.envelopeTos}
								</Text>
								<Text as="span" variant="secondary" size="sm" truncate>
									{formatTime(record.datetime)}
								</Text>
								<span>
									<ResultBadge
										kind={resolveResult({
											status: record.status,
											action:
												record.direction === "routing"
													? record.action
													: undefined,
										})}
										reason={record.errorDetail}
									/>
								</span>
							</button>
						))}
					</div>
				)}
			</div>

			{direction === "routing" ? (
				<SendTestDialog
					worker={worker}
					open={sendOpen}
					onOpenChange={setSendOpen}
					onSent={() => void load()}
				/>
			) : null}
		</>
	);
}
