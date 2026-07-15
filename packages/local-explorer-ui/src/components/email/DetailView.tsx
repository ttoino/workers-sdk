import {
	Badge,
	Banner,
	Button,
	Empty,
	LayerCard,
	Text,
} from "@cloudflare/kumo";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { emailListRoutingActivity, emailListSendingActivity } from "../../api";
import EmailIcon from "../../assets/icons/email.svg?react";
import { Breadcrumbs } from "../Breadcrumbs";
import { CopyButton } from "../CopyButton";
import { eventsForMessage, groupEvents } from "./groupEvents";
import { LogDetailFlow } from "./LogDetailFlow";
import { PreviewCard } from "./PreviewCard";
import { useSelectedWorkerName } from "./useSelectedWorker";
import type { EmailActivityRecord, EmailDirection } from "./types";
import type { ReactNode } from "react";

async function fetchAll(
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

function Row({
	label,
	className,
	children,
}: {
	label: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`}>
			<span className="text-xs font-semibold tracking-wide text-kumo-subtle uppercase">
				{label}
			</span>
			<div className="text-sm break-words text-kumo-default">{children}</div>
		</div>
	);
}

/**
 * The detail page for a single email message: a header of message constants
 * (subject, from, message id), the lifecycle flow of every event sharing the
 * message id, and — for sending — a rendered preview of the message body.
 */
export function DetailView({
	direction,
	id,
}: {
	direction: EmailDirection;
	id: string;
}) {
	const worker = useSelectedWorkerName();
	const navigate = useNavigate();

	const [records, setRecords] = useState<EmailActivityRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setRecords(null);
		setError(null);
		if (!worker) {
			setRecords([]);
			return;
		}
		void (async () => {
			try {
				const all = await fetchAll(worker, direction);
				if (!cancelled) {
					setRecords(all);
				}
			} catch (err) {
				if (!cancelled) {
					setError(
						err instanceof Error ? err.message : "Failed to load the message."
					);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [worker, direction, id]);

	const message = useMemo(() => {
		if (!records) {
			return null;
		}
		const target = records.find((record) => record.id === id);
		if (!target) {
			return null;
		}
		return groupEvents(eventsForMessage(records, target), direction);
	}, [records, id, direction]);

	function goBack() {
		void navigate({
			to: direction === "routing" ? "/email/routing" : "/email/sending",
			search: (prev) => prev,
		});
	}

	return (
		<>
			<Breadcrumbs
				icon={EmailIcon}
				items={[direction === "routing" ? "Routing" : "Sending", "Message"]}
				title="Email"
			/>

			<div className="space-y-4 px-8 py-6">
				<Button variant="ghost" size="sm" onClick={goBack}>
					<ArrowLeftIcon size={14} />
					Back to activity
				</Button>

				{error ? (
					<Banner variant="error" description={error} />
				) : records === null ? (
					<div className="p-12 text-center">
						<Text variant="secondary">Loading...</Text>
					</div>
				) : message === null ? (
					<Empty
						title="Message not found."
						description="This message may have been cleared from the local activity log."
					/>
				) : (
					<>
						<LayerCard>
							<LayerCard.Secondary>Lifecycle</LayerCard.Secondary>
							<LayerCard.Primary className="p-0">
								<LogDetailFlow message={message} />
							</LayerCard.Primary>
						</LayerCard>

						<LayerCard>
							<LayerCard.Secondary>Message</LayerCard.Secondary>
							<LayerCard.Primary>
								<div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
									<Row label="Subject" className="sm:col-span-2">
										{message.subject || "—"}
									</Row>
									{message.messageId ? (
										<Row label="Message ID" className="sm:col-span-2">
											<span className="flex items-center gap-2 break-all">
												{message.messageId}
												<CopyButton text={message.messageId} />
											</span>
										</Row>
									) : null}
									<Row label="Sender">
										<Badge variant="outline">{message.from || "—"}</Badge>
									</Row>
									<Row label="Recipients">
										<div className="flex flex-wrap gap-1.5">
											{message.recipients.length === 0 ? (
												<span>—</span>
											) : (
												message.recipients.map((recipient) => (
													<Badge key={recipient.envelopeTos} variant="outline">
														{recipient.envelopeTos || "—"}
													</Badge>
												))
											)}
										</div>
									</Row>
								</div>
							</LayerCard.Primary>
						</LayerCard>

						{message.messageId ? (
							<PreviewCard worker={worker} messageId={message.messageId} />
						) : null}
					</>
				)}
			</div>
		</>
	);
}
