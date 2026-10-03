// Players, new players and session lengths per day (7d, 30d) or per hour (24h) on the Analytics
// tab: a player counts in every period one of their sessions touches and is new in the period
// their first session on this server began; a session counts in the period it ended; days are cut
// in the time zone the viewer sends. Asia/Kolkata (UTC+5:30, no daylight saving) puts a day's
// start at 18:30 UTC, so a day cut in UTC would show; Europe/Berlin has a 25-hour day on
// 2026-10-25 and a 23-hour one on 2026-03-29. Every read is made at a fixed moment.
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import { playerSessions } from '$lib/server/db/schema';
import { loadPeriods, timeZone, type PeriodPoint } from '$lib/server/analytics';
import { hasTestDb, testEnv } from './db';
import { callApi } from './call';
import { seedWorld, type World } from './world';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const IST = 5.5 * HOUR;
const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
/** 13:30 in Kolkata on Wednesday 30 September 2026 */
const AT = Date.parse('2026-09-30T08:00:00Z');

const NEWBIE = '76561198000000401';
const REGULAR = '76561198000000402';
const NIGHT = '76561198000000403';
const BLIP = '76561198000000404';
const ONLINE = '76561198000000405';
const ELSEWHERE = '76561198000000406';
const EARLY = '76561198000000407';
const HOURLY = '76561198000000408';
const HOURLY_OLD = '76561198000000409';
const ZONED = '76561198000000410';
const FIRST_DAY = '76561198000000411';

/** The start of the day `back` days before AT's in a zone `offset` ahead of UTC, as an instant. */
const dayStart = (back: number, offset: number) =>
	Math.floor((AT + offset) / DAY) * DAY - offset - back * DAY;
/** The start of day k of the seven (0 the oldest, 6 AT's) in Asia/Kolkata. */
const d = (k: number) => dayStart(6 - k, IST);
/** The start of hour k of the twenty-four (23 the one AT is in) in Asia/Kolkata. */
const h = (k: number) => Math.floor((AT + IST) / HOUR) * HOUR - IST - (23 - k) * HOUR;
const at = (t: number) => new Date(t);
const iso = (t: number) => at(t).toISOString();
const row = (p: PeriodPoint) => [p.players, p.newPlayers, p.sessions];

describe.skipIf(!hasTestDb)('players and sessions per period', () => {
	let env: Env;
	let w: World;
	let w2: World;
	/** servers of their own for the clock changes, so their sessions stay out of the rest */
	const tag = randomBytes(4).toString('hex');
	const FALL = `dst-fall-${tag}`;
	const SPRING = `dst-spring-${tag}`;
	const session = (serverId: string, steamId: string, from: number, to: number | null) => ({
		serverId,
		steamId,
		name: steamId.slice(-3),
		joinedAt: at(from),
		lastSeen: at(to ?? AT - MIN),
		leftAt: to === null ? null : at(to)
	});

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		w2 = await seedWorld(env);
		const here = w.server.id;
		await env.db.insert(playerSessions).values([
			// a first visit on day 2, an hour and a half, and back on day 5 for 45 minutes: new on
			// day 2 only
			session(here, NEWBIE, d(2) + 10 * HOUR, d(2) + 11.5 * HOUR),
			session(here, NEWBIE, d(5) + 18 * HOUR, d(5) + 18.75 * HOUR),
			// a regular from before the week, back on day 4 for half an hour
			session(here, REGULAR, d(0) - 3 * DAY, d(0) - 3 * DAY + HOUR),
			session(here, REGULAR, d(4) + 9 * HOUR, d(4) + 9.5 * HOUR),
			// a first visit from 23:00 on day 3 to 01:00 on day 4: on both days, ended on day 4
			session(here, NIGHT, d(3) + 23 * HOUR, d(4) + HOUR),
			// a first visit on day 4 of ten minutes
			session(here, BLIP, d(4) + 12 * HOUR, d(4) + 12 * HOUR + 10 * MIN),
			// on at AT, first visit that day: present and new, but no session has ended
			session(here, ONLINE, d(6) + 30 * MIN, null),
			// played on the org's other server before the week: still new here on day 5
			session(w.otherServer.id, ELSEWHERE, d(0) - 2 * DAY, d(0) - 2 * DAY + HOUR),
			session(w.otherServer.id, ELSEWHERE, d(5) + 7 * HOUR, d(5) + 7.5 * HOUR),
			session(here, ELSEWHERE, d(5) + 8 * HOUR, d(5) + 8 * HOUR + 20 * MIN),
			// a first visit in the week's first hour: new on day 0
			session(here, FIRST_DAY, d(0) + HOUR, d(0) + 1.5 * HOUR),
			// on since 22:00 the evening before the week, four hours, and back on day 3: never new
			session(here, EARLY, d(0) - 2 * HOUR, d(0) + 2 * HOUR),
			session(here, EARLY, d(3) + 14 * HOUR, d(3) + 14.5 * HOUR),
			// another tenant's server: nothing of it here
			session(w.otherOrgServer.id, NEWBIE, d(4) + HOUR, d(4) + 2 * HOUR)
		]);
		await env.db.insert(playerSessions).values([
			// the hourly view, on a server of its own: a first visit over three hours, ended in
			// hour 22 after 115 minutes, and a regular's half hour in hour 5
			session(w2.server.id, HOURLY, h(20) + 10 * MIN, h(22) + 5 * MIN),
			session(w2.server.id, HOURLY_OLD, h(0) - 2 * DAY, h(0) - 2 * DAY + HOUR),
			session(w2.server.id, HOURLY_OLD, h(5), h(5) + 30 * MIN),
			// one session from 01:00 to 02:00 on day 3 in Kolkata, 20:30 UTC the day before
			session(w2.otherServer.id, ZONED, d(3) + HOUR, d(3) + 2 * HOUR),
			// Berlin's 25-hour Sunday: 02:30 summer time, 02:30 winter time and 23:30 are on it,
			// ten past midnight is Monday's
			session(
				FALL,
				'76561198000000421',
				Date.parse('2026-10-25T00:30Z'),
				Date.parse('2026-10-25T00:50Z')
			),
			session(
				FALL,
				'76561198000000422',
				Date.parse('2026-10-25T01:30Z'),
				Date.parse('2026-10-25T01:50Z')
			),
			session(
				FALL,
				'76561198000000423',
				Date.parse('2026-10-25T22:30Z'),
				Date.parse('2026-10-25T22:50Z')
			),
			session(
				FALL,
				'76561198000000424',
				Date.parse('2026-10-25T23:10Z'),
				Date.parse('2026-10-25T23:20Z')
			),
			// Berlin's 23-hour Sunday: 23:30 summer time is on it, ten past midnight is Monday's
			session(
				SPRING,
				'76561198000000425',
				Date.parse('2026-03-29T21:30Z'),
				Date.parse('2026-03-29T21:45Z')
			),
			session(
				SPRING,
				'76561198000000426',
				Date.parse('2026-03-29T22:10Z'),
				Date.parse('2026-03-29T22:20Z')
			)
		]);
	});

	const days = (tz: string | null, serverId = w.server.id, range: '7d' | '30d' = '7d') =>
		loadPeriods(env, serverId, range, tz, at(AT));

	test('a week in the viewer’s days: players, new players, sessions ended', async () => {
		const a = await days('Asia/Kolkata');
		expect(a.tz).toBe('Asia/Kolkata');
		expect(a.unit).toBe('day');
		expect(a.periods.map((p) => p.ts)).toEqual([0, 1, 2, 3, 4, 5, 6].map((k) => iso(d(k))));
		expect(a.periods.map(row)).toEqual([
			[2, 1, 2], // EARLY; FIRST_DAY, new
			[0, 0, 0],
			[1, 1, 1], // NEWBIE
			[2, 1, 1], // NIGHT arrives; EARLY back
			[3, 1, 3], // REGULAR, NIGHT (ends), BLIP (new)
			[2, 1, 2], // ELSEWHERE, new to this server; NEWBIE back, not new again
			[1, 1, 0] // ONLINE, still on
		]);
	});

	test('a session counts with its whole length on the day it ended', async () => {
		const p = (await days('Asia/Kolkata')).periods;
		// four hours and half an hour
		expect([p[0].avgSessionS, p[0].medianSessionS]).toEqual([8100, 8100]);
		expect([p[2].avgSessionS, p[2].medianSessionS]).toEqual([5400, 5400]);
		// 30, 120 and 10 minutes
		expect([p[4].avgSessionS, p[4].medianSessionS]).toEqual([3200, 1800]);
		// 20 and 45 minutes
		expect([p[5].avgSessionS, p[5].medianSessionS]).toEqual([1950, 1950]);
		// nothing ended: no length, not zero
		expect([p[1].avgSessionS, p[6].avgSessionS, p[6].medianSessionS]).toEqual([null, null, null]);
	});

	test('thirty days take in the week and the visits before it', async () => {
		const p = (await days('Asia/Kolkata', w.server.id, '30d')).periods;
		expect(p).toHaveLength(30);
		expect(p[0].ts).toBe(iso(dayStart(29, IST)));
		const rows = p.map(row);
		// the week as above, EARLY no longer new there
		expect(rows.slice(23)).toEqual((await days('Asia/Kolkata')).periods.map(row));
		// REGULAR's first visit, three days before the week, and EARLY arriving the evening before it
		expect(rows[20]).toEqual([1, 1, 1]);
		expect(rows[22]).toEqual([1, 1, 0]);
		expect(
			rows
				.filter((_, i) => i < 23 && i !== 20 && i !== 22)
				.flat()
				.every((v) => v === 0)
		).toBe(true);
	});

	test('the day is cut in the zone sent: the same session falls on another day in UTC', async () => {
		const zoned = (await days('Asia/Kolkata', w2.otherServer.id)).periods;
		const utc = (await days('UTC', w2.otherServer.id)).periods;
		const ended = (ps: PeriodPoint[]) => ps.filter((p) => p.sessions).map((p) => p.ts);
		expect(ended(zoned)).toEqual([iso(d(3))]);
		// 20:30 UTC on the day before, which UTC starts at midnight
		expect(ended(utc)).toEqual([iso(Math.floor((d(3) + 2 * HOUR) / DAY) * DAY)]);
		expect(utc.every((p) => p.ts.endsWith('T00:00:00.000Z'))).toBe(true);
	});

	test('a day is as long as the clocks make it', async () => {
		const fall = await loadPeriods(env, FALL, '7d', 'Europe/Berlin', new Date('2026-10-26T12:00Z'));
		// Sunday 25 October starts at midnight summer time and ends at midnight winter time
		expect(fall.periods.slice(5).map((p) => p.ts)).toEqual([
			'2026-10-24T22:00:00.000Z',
			'2026-10-25T23:00:00.000Z'
		]);
		expect(fall.periods.slice(5).map(row)).toEqual([
			[3, 3, 3],
			[1, 1, 1]
		]);
		const spring = await loadPeriods(
			env,
			SPRING,
			'7d',
			'Europe/Berlin',
			new Date('2026-03-30T12:00Z')
		);
		// Sunday 29 March starts at midnight winter time and ends at midnight summer time
		expect(spring.periods.slice(5).map((p) => p.ts)).toEqual([
			'2026-03-28T23:00:00.000Z',
			'2026-03-29T22:00:00.000Z'
		]);
		expect(spring.periods.slice(5).map(row)).toEqual([
			[1, 1, 1],
			[1, 1, 1]
		]);
	});

	test('a day is the hours of the last day, counted back from the one running', async () => {
		const a = await loadPeriods(env, w2.server.id, '24h', 'Asia/Kolkata', at(AT));
		expect(a.unit).toBe('hour');
		// hours start on the half hour in UTC, as Kolkata's do
		expect(a.periods.map((p) => p.ts)).toEqual(Array.from({ length: 24 }, (_, k) => iso(h(k))));
		expect(a.periods[23].ts).toBe('2026-09-30T07:30:00.000Z');
		const on = a.periods.flatMap((p, k) => (p.players ? [[k, ...row(p)]] : []));
		expect(on).toEqual([
			[5, 1, 0, 1],
			[20, 1, 1, 0],
			[21, 1, 0, 0],
			[22, 1, 0, 1]
		]);
		expect([a.periods[5].avgSessionS, a.periods[22].avgSessionS]).toEqual([1800, 115 * 60]);
	});

	test('a zone Postgres does not know, or none, cuts the days in UTC', async () => {
		expect(await timeZone(env, 'Asia/Calcutta')).toBe('Asia/Calcutta');
		expect(await timeZone(env, 'Europe/Kyiv')).toBe('Europe/Kyiv');
		for (const bad of [null, '', 'Mars/Olympus_Mons', "UTC'; SELECT 1; --", 'x'.repeat(65)])
			expect(await timeZone(env, bad)).toBe('UTC');
		const a = await days('Nowhere/Atall');
		expect(a.tz).toBe('UTC');
		expect(a.periods.every((p) => p.ts.endsWith('T00:00:00.000Z'))).toBe(true);
	});

	test('the route passes the zone on; the series reaches who may open the server, nobody else', async () => {
		const { GET } = await import(join(ROUTES, 'servers/[id]/analytics/periods', '+server.ts'));
		const ask = (who: keyof World['users']) =>
			callApi(GET, w.users[who], {
				params: { id: w.server.id },
				query: 'range=7d&tz=Asia%2FKolkata'
			});
		const viewer = await ask('viewer');
		expect(viewer.status).toBe(200);
		const body = viewer.body as { tz: string; unit: string; periods: PeriodPoint[] };
		expect([body.tz, body.unit, body.periods.length]).toEqual(['Asia/Kolkata', 'day', 7]);
		expect((await ask('keyView')).status).toBe(200);
		expect((await ask('anon')).status).toBe(401);
		expect((await ask('outsider')).status).toBe(404);
		expect((await ask('stranger')).status).toBe(404);
		expect((await ask('keyElsewhere')).status).toBe(404);
	});

	test('it answers a chart that refreshes and then asks for a pause', async () => {
		const { GET } = await import(join(ROUTES, 'servers/[id]/analytics/periods', '+server.ts'));
		const { assertRate, resetRates } = await import('$lib/server/ratelimit');
		resetRates();
		for (let i = 0; i < 30; i++) assertRate(`periods:${w.users.viewer!.id}`, 30, 60_000);
		// callApi resets the limiter, so the handler is called as SvelteKit would call it
		const res = await GET({
			locals: { user: w.users.viewer, session: null, apiKey: null },
			params: { id: w.server.id },
			url: new URL('http://localhost/test?range=7d'),
			request: new Request('http://localhost/test')
		} as never);
		expect(res.status).toBe(429);
	});
});
