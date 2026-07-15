import { Badge, Tooltip } from "@cloudflare/kumo";
import {
	RESULT_BADGE_VARIANT,
	RESULT_LABEL,
	type ResultKind,
} from "./resultLabel";

interface ResultBadgeProps {
	kind: ResultKind;
	/**
	 * Optional human-readable reason for the outcome (the row's `errorDetail`).
	 * When present it's surfaced as a hover tooltip on the badge — e.g. the
	 * rejection detail behind a "Delivery failed" or "Error".
	 */
	reason?: string;
}

/**
 * Renders an email result as a Kumo `<Badge>` for the activity-log Result
 * column and reused wherever a record's result needs naming. Label + variant
 * come from the shared `resultLabel` vocabulary so routing and sending stay
 * consistent with the flow.
 */
export function ResultBadge({ kind, reason }: ResultBadgeProps) {
	const badge = (
		<Badge variant={RESULT_BADGE_VARIANT[kind]}>{RESULT_LABEL[kind]}</Badge>
	);

	if (!reason) {
		return badge;
	}

	return <Tooltip content={reason}>{badge}</Tooltip>;
}
