// Players, new players and session lengths per hour or per day, for the Analytics tab's charts
// beside Players online: who played on the server, which View already shows there. Asked for
// only while one of those charts is open, since it reads the range's sessions on every call.
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerCap } from '$lib/server/access';
import { assertRate } from '$lib/server/ratelimit';
import { loadPeriods, parseRange } from '$lib/server/analytics';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server, user } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'server.view'
	);
	// One read of the range's sessions per call: enough for a chart that refreshes every minute
	// and a few clicks between ranges, not a scrape.
	assertRate(`periods:${user.id}`, 30, 60_000);
	const p = event.url.searchParams;
	return apiJson({
		ok: true,
		...(await loadPeriods(env, server.id, parseRange(p.get('range')), p.get('tz')))
	});
});
