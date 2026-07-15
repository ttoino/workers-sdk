import { createFileRoute } from "@tanstack/react-router";
import { ActivityView } from "../../../components/email/ActivityView";
import { ResourceError } from "../../../components/ResourceError";

export const Route = createFileRoute("/email/sending/")({
	component: () => <ActivityView direction="sending" />,
	errorComponent: ResourceError,
	validateSearch: (search: Record<string, unknown>): { worker?: string } => ({
		worker: typeof search.worker === "string" ? search.worker : undefined,
	}),
});
