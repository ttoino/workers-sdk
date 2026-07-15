import { createFileRoute } from "@tanstack/react-router";
import { DetailView } from "../../../components/email/DetailView";
import { ResourceError } from "../../../components/ResourceError";

export const Route = createFileRoute("/email/routing/$id")({
	component: RoutingDetail,
	errorComponent: ResourceError,
	validateSearch: (search: Record<string, unknown>): { worker?: string } => ({
		worker: typeof search.worker === "string" ? search.worker : undefined,
	}),
});

function RoutingDetail() {
	const { id } = Route.useParams();
	return <DetailView direction="routing" id={id} />;
}
