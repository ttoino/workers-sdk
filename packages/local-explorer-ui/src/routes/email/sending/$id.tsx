import { createFileRoute } from "@tanstack/react-router";
import { DetailView } from "../../../components/email/DetailView";
import { ResourceError } from "../../../components/ResourceError";

export const Route = createFileRoute("/email/sending/$id")({
	component: SendingDetail,
	errorComponent: ResourceError,
	validateSearch: (search: Record<string, unknown>): { worker?: string } => ({
		worker: typeof search.worker === "string" ? search.worker : undefined,
	}),
});

function SendingDetail() {
	const { id } = Route.useParams();
	return <DetailView direction="sending" id={id} />;
}
