import { getRouteApi, useRouterState } from "@tanstack/react-router";
import { useMemo } from "react";
import { getSelectedWorker } from "../WorkerSelector";

const rootRoute = getRouteApi("__root__");

/**
 * Resolves the currently selected Worker's name from the `worker` search param,
 * falling back to the first visible Worker when the param is absent (mirroring
 * the sidebar's selection). Email activity is scoped per Worker, so every email
 * route reads its target Worker through this hook.
 */
export function useSelectedWorkerName(): string {
	const rootData = rootRoute.useLoaderData();
	const routerState = useRouterState();
	const worker = useMemo(
		() => getSelectedWorker(rootData.workers, routerState.location.searchStr),
		[rootData.workers, routerState.location.searchStr]
	);
	return worker?.name ?? "";
}
