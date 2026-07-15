import { Empty, Flow } from "@cloudflare/kumo";
import { EventNode } from "./EventNode";
import type { LogDetailMessage } from "./types";

/**
 * Renders a message lifecycle as a Kumo `<Flow>`.
 *
 * - **Single recipient** (every routing message, most sending messages) → flat
 *   top-to-bottom sequence: one `<Flow.Node>` per event in ascending `datetime`
 *   order.
 * - **Multiple recipients** (sending messages fanning one `messageId` out to
 *   >1 envelope recipient) → top-level `<Flow.Parallel>` where each branch is a
 *   `<Flow.List>` of that recipient's events.
 */
export function LogDetailFlow({ message }: { message: LogDetailMessage }) {
	const recipients = message.recipients.filter((r) => r.events.length > 0);
	const [firstRecipient, ...restRecipients] = recipients;
	const isFanOut = restRecipients.length > 0;

	if (firstRecipient === undefined) {
		return <Empty size="sm" title="No events for this message." />;
	}

	return (
		<div className="rounded-lg bg-[radial-gradient(var(--color-kumo-subtle)_1px,transparent_1px)] bg-size-[16px_16px] p-4">
			{isFanOut ? (
				<Flow orientation="horizontal">
					<Flow.Parallel>
						{recipients.map((recipient) => (
							<Flow.List key={recipient.envelopeTos}>
								{recipient.events.map((event) => (
									<EventNode key={event.id} event={event} />
								))}
							</Flow.List>
						))}
					</Flow.Parallel>
				</Flow>
			) : (
				<Flow orientation="horizontal">
					{firstRecipient.events.map((event) => (
						<EventNode key={event.id} event={event} />
					))}
				</Flow>
			)}
		</div>
	);
}
