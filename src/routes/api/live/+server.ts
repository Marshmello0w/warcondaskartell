// The worker's latest view of the servers the caller may see: ?ids=a,b, or ?org=<id> for that
// organisation's (default: all of them). A list of every server does not fit in a URL, so pages
// that show a whole fleet name it by org. ?slim=1 leaves out the player lists.
import { getEnv } from '$lib/server/env';
import { apiJson, route } from '$lib/server/http';
import { accessibleServers, requireUser } from '$lib/server/access';
import { gateway } from '$lib/server/gateway';
import { slimView } from '$lib/server/live';

export const GET = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const p = event.url.searchParams;
	const mine = new Set((await accessibleServers(env, user, p.get('org') || null)).map((s) => s.id));
	const asked = (p.get('ids') || '').split(',').filter(Boolean);
	const ids = (asked.length ? asked : [...mine]).filter((id) => mine.has(id));
	const live = await gateway().live(env, ids);
	const slim = p.get('slim') === '1';
	return apiJson({
		ok: true,
		live: Object.fromEntries([...live].map(([id, v]) => [id, slim ? slimView(v) : v]))
	});
});
