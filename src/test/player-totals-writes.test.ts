// The totals' triggers (migration 0038) under the writes the random histories do not reach: one
// statement that closes a session and edits a closed one of the same player, or ends a match and
// edits an ended one; a transaction that ends a match and then changes its lines and its winner;
// an upsert of an ended match's lines; a statement that fails after a close; a purge. Then two
// transactions on one server, the worker's (a close, a match end, an abandoned match, leavers'
// lines, the offline transition) and a purge, each holding the server's totals lock while the
// other waits for it, in both orders: no deadlock, and the totals exact after. Taking the lock
// first is what makes that so: without it, an abandoned match against a purge deadlocks; and,
// taken before the lease row, a purge holding it does not hold up the lease renewal, while a write
// that waited for it as the lease changed hands and came back is dropped. A
// transaction that is not READ COMMITTED is refused. Last, migration 0038 run over a database that
// already has history builds the totals the reads expect.
import { beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { connect, runMigrations, type DbOrTx } from '$lib/server/db';
import { matches, matchPlayers, playerSessions } from '$lib/server/db/schema';
import {
	acquireOrRenew,
	isOwner,
	ownershipPeriod,
	StaleOwnership,
	withOwnedTransaction
} from '$lib/server/leadership';
import { writeMatchPlayers } from '$lib/server/match-players';
import { purgeServerStats } from '$lib/server/stats';
import { lockTotals } from '$lib/server/totals';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';
import { oracleBase, totalsRows } from './totals-oracle';

const P = '76561198000032001';
const Q = '76561198000032002';
const R = '76561198000032003';
const HOUR = 3_600_000;
const scores = [
	{ name: 'Valkyra', score: 100 },
	{ name: 'Lonestar', score: 60 }
];

function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => (open = resolve));
	return { open, opened };
}

describe.skipIf(!hasTestDb)('player totals under every kind of write', () => {
	let env: Env;

	/** The totals of these servers equal what today's reads compute, in one snapshot. */
	const exact = async (ids: string[]) => {
		await env.db.transaction(async (tx) => {
			expect(await totalsRows(tx, ids)).toEqual(await oracleBase(tx, ids));
		});
	};
	const t0 = Date.now() - 20 * HOUR;
	const at = (h: number) => new Date(t0 + h * HOUR);
	const session = async (
		serverId: string,
		steamId: string,
		from: number,
		to: number | null,
		cash = 100
	) =>
		(
			await env.db
				.insert(playerSessions)
				.values({
					serverId,
					steamId,
					name: `n${steamId.slice(-2)}`,
					faction: 'Valkyra',
					joinedAt: at(from),
					lastSeen: at(to ?? from + 0.5),
					leftAt: to === null ? null : at(to),
					kills: 3,
					deaths: 2,
					cash,
					seedSeconds: 60
				})
				.returning({ id: playerSessions.id })
		)[0].id;
	const match = async (
		serverId: string,
		from: number,
		ended: boolean,
		winner: string | null = 'Valkyra'
	) =>
		(
			await env.db
				.insert(matches)
				.values({
					serverId,
					startedAt: at(from),
					endedAt: ended ? at(from + 1) : null,
					map: 'Kavkazi',
					finalScores: ended ? scores : null,
					winner: ended ? winner : null
				})
				.returning({ id: matches.id })
		)[0].id;
	const line = (
		matchId: number,
		serverId: string,
		steamId: string,
		faction: string | null,
		kills = 4
	) =>
		env.db.insert(matchPlayers).values({
			matchId,
			serverId,
			steamId,
			name: 'l',
			faction,
			seconds: 600,
			kills,
			deaths: 2,
			headshots: 1,
			killStreak: kills
		});
	/** Someone waits for a server's totals lock (another transaction holds it). */
	const untilWaiting = async () => {
		const end = Date.now() + 10_000;
		for (;;) {
			const [row] = (await env.db.execute(sql`
				SELECT COUNT(*)::int AS n FROM pg_locks
				 WHERE locktype = 'advisory' AND NOT granted
				   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)) as {
				n: number;
			}[];
			if (row.n > 0) return;
			if (Date.now() > end) throw new Error('nobody waited for the lock');
			await Bun.sleep(20);
		}
	};

	beforeAll(async () => {
		env = await testEnv();
	});

	test('a statement that closes a session and edits a closed one of the same player counts each once', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		for (const openFirst of [false, true]) {
			const steamId = openFirst ? Q : P;
			const a = openFirst ? await session(A, steamId, 3, null) : await session(A, steamId, 1, 2);
			const b = openFirst ? await session(A, steamId, 1, 2) : await session(A, steamId, 3, null);
			const [open, closed] = openFirst ? [a, b] : [b, a];
			// left_at in the SET list: the open row's close adds (BEFORE), the closed row's edit
			// recounts the pair from the statement's end state (AFTER)
			await env.db.execute(sql`
				UPDATE player_sessions SET left_at = CASE WHEN id = ${open} THEN last_seen ELSE left_at END,
				       cash = cash + 7
				 WHERE id IN (${open}, ${closed})`);
			await exact([A]);
		}
		// two closes of one pair in one statement add twice, once each
		const c = await session(A, R, 4, null);
		const d = await session(A, R, 5, null);
		await env.db.execute(
			sql`UPDATE player_sessions SET left_at = last_seen WHERE id IN (${c}, ${d})`
		);
		await exact([A]);
		const [row] = (await env.db.execute(sql`
			SELECT sessions FROM player_totals WHERE server_id = ${A} AND steam_id = ${R}`)) as {
			sessions: number;
		}[];
		expect(row.sessions).toBe(2);
	});

	test('a statement that fails after a close adds nothing', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		const a = await session(A, P, 1, null);
		const b = await session(A, P, 2, null);
		await expect(
			(async () =>
				env.db.execute(sql`
					UPDATE player_sessions SET left_at = last_seen,
					       kills = CASE WHEN id = ${b} THEN kills / 0 ELSE kills END
					 WHERE id IN (${a}, ${b})`))()
		).rejects.toThrow();
		await exact([A]);
		expect(
			await env.db.execute(sql`SELECT 1 FROM player_totals WHERE server_id = ${A}`)
		).toHaveLength(0);
	});

	test('a match ended, then its lines and its winner changed, in one transaction; and in one statement with an ended match', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		await session(A, P, 0, 4);
		const m = await match(A, 1, false);
		await line(m, A, P, 'Valkyra');
		await line(m, A, Q, 'Lonestar');
		await env.db.transaction(async (tx) => {
			await tx
				.update(matches)
				.set({ endedAt: at(2), finalScores: scores, winner: 'Valkyra' })
				.where(eq(matches.id, m));
			await tx.execute(sql`UPDATE match_players SET kills = kills + 5 WHERE match_id = ${m}`);
			await tx.update(matches).set({ winner: 'Lonestar' }).where(eq(matches.id, m));
		});
		await exact([A]);
		// one statement ending an open match and editing an ended one, both with P
		const open = await match(A, 3, false);
		await line(open, A, P, 'Lonestar', 9);
		await env.db.execute(sql`
			UPDATE matches SET ended_at = COALESCE(ended_at, ${at(4)}), final_scores = ${JSON.stringify(scores)}::jsonb,
			       winner = 'Lonestar'
			 WHERE id IN (${m}, ${open})`);
		await exact([A]);
		// an upsert of an ended match's lines fires both statement triggers
		await writeMatchPlayers(env.db, A, m, [
			{ steamId: P, name: 'p', faction: 'Valkyra', seconds: 1, kills: 1, deaths: 1, cashDelta: 0 },
			{ steamId: R, name: 'r', faction: 'White', seconds: 1, kills: 2, deaths: 0, cashDelta: 0 }
		]);
		await exact([A]);
		// a line moved to another player, a match moved to another server, a line deleted
		await env.db.execute(
			sql`UPDATE match_players SET steam_id = ${R} WHERE match_id = ${open} AND steam_id = ${P}`
		);
		await exact([A]);
		await env.db.update(matches).set({ serverId: w.otherServer.id }).where(eq(matches.id, open));
		await exact([A]);
		await exact([w.otherServer.id]);
		await env.db.execute(sql`DELETE FROM match_players WHERE match_id = ${m} AND steam_id = ${Q}`);
		await exact([A]);
	});

	test('a purge leaves the totals as its sources: sessions kept, lines gone, lines-only players gone', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		await session(A, P, 0, 3);
		const m = await match(A, 1, true);
		await line(m, A, P, 'Valkyra');
		await line(m, A, Q, 'Lonestar');
		await exact([A]);
		await purgeServerStats(env, new Request('http://localhost/'), w.users.owner!, {
			...(await env.db.query.servers.findFirst({ where: (s, { eq }) => eq(s.id, A) }))!
		});
		await exact([A]);
		const rows = (await env.db.execute(sql`
			SELECT steam_id, sessions, matches FROM player_totals WHERE server_id = ${A}`)) as {
			steam_id: string;
			sessions: number;
			matches: number;
		}[];
		expect(rows).toEqual([{ steam_id: P, sessions: 1, matches: 0 }]);
	});

	test('a transaction that is not READ COMMITTED is refused', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		const id = await session(A, P, 0, 1);
		const refused = await env.db
			.transaction(
				async (tx) => {
					await tx.update(playerSessions).set({ cash: 1 }).where(eq(playerSessions.id, id));
				},
				{ isolationLevel: 'repeatable read' }
			)
			.then(
				() => null,
				(err: { cause?: { message?: string } }) => err
			);
		expect(String(refused?.cause?.message)).toMatch(/READ COMMITTED only/);
		await exact([A]);
	});

	describe('the worker and a purge on one server', () => {
		/** History on a server: a closed and an open session, an ended match, an open one with lines. */
		const history = async () => {
			const w = await seedWorld(env);
			const A = w.server.id;
			await session(A, P, 0, 2);
			const open = await session(A, Q, 3, null);
			const ended = await match(A, 0, true);
			await line(ended, A, P, 'Valkyra');
			const current = await match(A, 2, false);
			await line(current, A, Q, 'Lonestar');
			return { w, A, open, current };
		};
		/** The purge's statements, the lock first, pausing after the lines when told to. */
		const purge = (A: string, pause?: Promise<void>, paused?: () => void) =>
			env.db.transaction(async (tx) => {
				await lockTotals(tx, A);
				await tx.execute(sql`DELETE FROM kills WHERE server_id = ${A}`);
				await tx.execute(sql`DELETE FROM match_players WHERE server_id = ${A}`);
				paused?.();
				if (pause) await pause;
				await tx.execute(sql`DELETE FROM matches WHERE server_id = ${A}`);
			});
		const kinds: Record<
			string,
			(tx: DbOrTx, h: Awaited<ReturnType<typeof history>>) => Promise<unknown>
		> = {
			'a session closing': (tx, h) =>
				tx.execute(
					sql`UPDATE player_sessions SET left_at = last_seen WHERE id = ${h.open} AND left_at IS NULL`
				),
			"leavers' lines": (tx, h) =>
				writeMatchPlayers(tx, h.A, h.current, [
					{
						steamId: Q,
						name: 'q',
						faction: 'Lonestar',
						seconds: 9,
						kills: 7,
						deaths: 1,
						cashDelta: 5
					}
				]),
			'a match ending': async (tx, h) => {
				await writeMatchPlayers(tx, h.A, h.current, [
					{
						steamId: Q,
						name: 'q',
						faction: 'Lonestar',
						seconds: 9,
						kills: 7,
						deaths: 1,
						cashDelta: 5
					},
					{
						steamId: R,
						name: 'r',
						faction: 'Valkyra',
						seconds: 9,
						kills: 1,
						deaths: 4,
						cashDelta: 0
					}
				]);
				await tx
					.update(matches)
					.set({ endedAt: new Date(), finalScores: scores, winner: 'Valkyra' })
					.where(eq(matches.id, h.current));
			},
			'an abandoned match': (tx, h) =>
				tx.update(matches).set({ endedAt: new Date() }).where(eq(matches.id, h.current)),
			'the offline transition': async (tx, h) => {
				await tx.execute(
					sql`UPDATE player_sessions SET left_at = last_seen WHERE server_id = ${h.A} AND left_at IS NULL`
				);
				await writeMatchPlayers(tx, h.A, h.current, [
					{
						steamId: Q,
						name: 'q',
						faction: 'Lonestar',
						seconds: 9,
						kills: 7,
						deaths: 1,
						cashDelta: 5
					}
				]);
			}
		};

		for (const [kind, write] of Object.entries(kinds)) {
			test(`${kind}, the purge holding the lock: the worker waits, both commit, exact`, async () => {
				const h = await history();
				const deleted = gate();
				const go = gate();
				const purging = purge(h.A, go.opened, deleted.open);
				await deleted.opened;
				const writing = env.db.transaction(async (tx) => {
					await lockTotals(tx, h.A);
					await write(tx, h);
				});
				await untilWaiting();
				go.open();
				await Promise.all([purging, writing]);
				await exact([h.A]);
			});
			test(`${kind}, the worker holding the lock: the purge waits, both commit, exact`, async () => {
				const h = await history();
				const written = gate();
				const go = gate();
				const writing = env.db.transaction(async (tx) => {
					await lockTotals(tx, h.A);
					await write(tx, h);
					written.open();
					await go.opened;
				});
				await written.opened;
				const purging = purge(h.A);
				await untilWaiting();
				go.open();
				await Promise.all([purging, writing]);
				await exact([h.A]);
			});
		}

		test('a purge holding the totals lock does not hold up the lease: the worker waits for the lock before the lease row', async () => {
			const h = await history();
			expect(await acquireOrRenew(env, 'totals-lease')).toBe(true);
			const deleted = gate();
			const go = gate();
			const purging = purge(h.A, go.opened, deleted.open);
			await deleted.opened;
			const writing = withOwnedTransaction(env, (tx) => tx.execute(sql`SELECT 1`), {
				totalsOf: h.A
			});
			// with the lease row held FOR SHARE by the waiting write, the renewal would queue
			// behind it until the purge let go
			let renewed: boolean | string = 'not tried';
			try {
				await untilWaiting();
				renewed = await Promise.race([
					acquireOrRenew(env, 'totals-lease'),
					Bun.sleep(3_000).then(() => 'stalled')
				]);
			} finally {
				go.open();
				await Promise.allSettled([purging, writing]);
			}
			expect(renewed).toBe(true);
			await exact([h.A]);
		});

		test('a write that waited for the totals lock while the lease changed hands and came back is dropped, not written', async () => {
			const h = await history();
			expect(await acquireOrRenew(env, 'totals-lease')).toBe(true);
			const period = ownershipPeriod();
			const deleted = gate();
			const go = gate();
			const purging = purge(h.A, go.opened, deleted.open);
			await deleted.opened;
			let ran = false;
			const writing = withOwnedTransaction(
				env,
				async () => {
					ran = true;
				},
				{ totalsOf: h.A, period }
			);
			let outcome: unknown = 'not settled';
			try {
				await untilWaiting();
				// another process takes the lease and lets it lapse; this one takes it back
				await env.db.execute(sql`
					UPDATE worker_ownership SET token = 'another process', acquired_at = now(),
					       lease_until = now() - interval '1 second'`);
				expect(await acquireOrRenew(env, 'totals-lease')).toBe(true);
				expect(ownershipPeriod()).not.toBe(period);
			} finally {
				go.open();
				const [w] = await Promise.allSettled([writing, purging]);
				outcome = w.status === 'rejected' ? w.reason : 'written';
			}
			expect(ran).toBe(false);
			expect(outcome).toBeInstanceOf(StaleOwnership);
			expect(isOwner()).toBe(true);
		});

		test('without the lock first, an abandoned match against a purge deadlocks', async () => {
			const h = await history();
			const deleted = gate();
			const go = gate();
			const purging = purge(h.A, go.opened, deleted.open);
			await deleted.opened;
			// the match row is locked by the update, then its trigger waits for the purge's lock;
			// the purge then wants that row
			const abandoning = env.db.transaction(async (tx) => {
				await tx.update(matches).set({ endedAt: new Date() }).where(eq(matches.id, h.current));
			});
			await untilWaiting();
			go.open();
			const settled = await Promise.allSettled([purging, abandoning]);
			const failed = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
			expect(failed).toHaveLength(1);
			expect(String(failed[0].reason?.cause?.message ?? failed[0].reason)).toMatch(/deadlock/);
			await exact([h.A]);
		});
	});

	test('migration 0038 over a database with history builds the totals the reads expect', async () => {
		const base = process.env.TEST_DATABASE_URL!;
		const name = `warcon_test_totals_${randomBytes(4).toString('hex')}`;
		const admin = new SQL(base, { max: 1 });
		await admin.unsafe(`CREATE DATABASE "${name}"`);
		const url = new URL(base);
		url.pathname = `/${name}`;
		const { client, db } = connect(url.href);
		const dir = await mkdtemp(join(tmpdir(), 'warcon-0037-'));
		try {
			// every migration before 0038
			await cp('drizzle', dir, { recursive: true });
			await rm(join(dir, '0038_player_totals.sql'));
			await rm(join(dir, 'meta', '0038_snapshot.json'));
			const journal = JSON.parse(await readFile(join(dir, 'meta', '_journal.json'), 'utf8'));
			journal.entries = journal.entries.filter(
				(e: { tag: string }) => e.tag !== '0038_player_totals'
			);
			await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
			await runMigrations(db, dir);
			// history as the worker leaves it: closed and open sessions; ended, drawn, abandoned and
			// open matches with lines, one of them on the holding side; a player with lines only
			const s = (
				server: string,
				steamId: string,
				from: number,
				to: number | null,
				cash: number
			) => ({
				serverId: server,
				steamId,
				name: `n${steamId.slice(-1)}`,
				faction: 'Valkyra',
				joinedAt: at(from),
				lastSeen: at(to ?? from + 0.25),
				leftAt: to === null ? null : at(to),
				kills: 1,
				deaths: 1,
				cash,
				seedSeconds: from * 10
			});
			await db
				.insert(playerSessions)
				.values([
					s('a', P, 0, 1.5, 500),
					s('a', P, 2, 3.25, 700),
					s('a', Q, 1, 2, 50),
					s('a', Q, 4, null, 20),
					s('b', P, 1, 1.75, 900),
					s('b', R, 3, null, 0)
				]);
			const [won, drawn, abandoned, open] = await db
				.insert(matches)
				.values([
					{
						serverId: 'a',
						startedAt: at(0),
						endedAt: at(1),
						map: 'Kavkazi',
						finalScores: scores,
						winner: 'Valkyra'
					},
					{
						serverId: 'a',
						startedAt: at(1),
						endedAt: at(2),
						map: 'Europe',
						finalScores: [
							{ name: 'Valkyra', score: 50 },
							{ name: 'Lonestar', score: 50 }
						],
						winner: null
					},
					{ serverId: 'b', startedAt: at(1), endedAt: at(2), map: 'Detroit' },
					{ serverId: 'a', startedAt: at(4), map: 'Kavkazi' }
				])
				.returning({ id: matches.id });
			const l = (
				matchId: number,
				server: string,
				steamId: string,
				faction: string | null,
				kills: number
			) => ({
				matchId: matchId,
				serverId: server,
				steamId,
				name: 'l',
				faction,
				seconds: 300,
				kills,
				deaths: 1,
				killStreak: kills
			});
			await db
				.insert(matchPlayers)
				.values([
					l(won.id, 'a', P, 'Valkyra', 5),
					l(won.id, 'a', Q, 'White', 2),
					l(drawn.id, 'a', P, 'Lonestar', 3),
					l(drawn.id, 'a', 'lines-only-player', 'Valkyra', 7),
					l(abandoned.id, 'b', P, 'Valkyra', 4),
					l(open.id, 'a', Q, 'Lonestar', 9)
				]);
			// then 0038
			await runMigrations(db, 'drizzle');
			await db.transaction(async (tx) => {
				for (const ids of [['a'], ['b'], ['a', 'b']])
					expect(await totalsRows(tx, ids)).toEqual(await oracleBase(tx, ids));
			});
			const [{ n }] = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM player_totals`)) as {
				n: number;
			}[];
			// (a, P), (a, Q), (b, P) from closed sessions and lines; the lines-only player; not (b, R),
			// whose only session is open
			expect(n).toBe(4);
		} finally {
			await client.close();
			await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
			await admin.close();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
