import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { reorderRoles } from '$lib/server/roles';

/** {ids[]}: every role of the org once, first to last (409 `stale` otherwise). */
export const PUT = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const roles = await reorderRoles(env, event.request, user, org, await readJson(event.request));
	return apiJson({ ok: true, roles });
});
