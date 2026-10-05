import { describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, pendingMigrations, runMigrations } from '$lib/server/db';
import { hasTestDb } from './db';

const journalPath = 'drizzle/meta/_journal.json';

test('migration journal is strictly chronological and keeps the applied feed migration', async () => {
	const journal = JSON.parse(await readFile(journalPath, 'utf8'));
	for (let i = 1; i < journal.entries.length; i++) {
		expect(journal.entries[i].idx).toBe(i);
		expect(journal.entries[i].when).toBeGreaterThan(journal.entries[i - 1].when);
	}
	const feed = journal.entries.find((e: { tag: string }) => e.tag === '0037_feed_event_times');
	expect(feed).toMatchObject({ idx: 37, when: 1791129692378 });
});

describe.skipIf(!hasTestDb)('upgrading the deployed feed-time schema', () => {
	test('applies both incoming migrations once and preserves old kills, clocks and deduplication', async () => {
		const name = 'warcon_test_merge_' + randomBytes(5).toString('hex');
		const admin = new SQL(process.env.TEST_DATABASE_URL!, { max: 1 });
		const url = new URL(process.env.TEST_DATABASE_URL!);
		url.pathname = '/' + name;
		await admin.unsafe(`CREATE DATABASE "${name}"`);
		const { client, db } = connect(url.href);
		const dir = await mkdtemp(join(tmpdir(), 'warcon-feed-upgrade-'));
		try {
			await cp('drizzle', dir, { recursive: true });
			const journal = JSON.parse(await readFile(journalPath, 'utf8'));
			journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 37);
			await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
			await runMigrations(db, dir);
			expect(await pendingMigrations(db, 'drizzle')).toBe(2);
			await client.unsafe(`INSERT INTO kills
				(ts, server_id, event_id, instance_id, match_id, event_time, map,
				 victim_steam_id, victim_name, tags) VALUES
				('2026-10-01T12:00:00Z','old-server','old-kill','boot','unreliable',10,'Map','victim','Victim','[]')`);
			await client.unsafe(`INSERT INTO feed_clocks
				(id,server_id,instance_id,source_id,map,first_receipt_at,last_receipt_at,anchor_at,max_event_time)
				VALUES ('old-clock','old-server','boot','bot','Map','2026-10-01T12:00:00Z',
				'2026-10-01T12:00:00Z','2026-10-01T11:59:50Z',10)`);
			await client.unsafe(`INSERT INTO player_sessions
				(server_id,steam_id,name,joined_at,last_seen,left_at,cash,seed_seconds)
				VALUES ('old-server','player','Player','2026-10-01T11:00:00Z',
				'2026-10-01T12:00:00Z','2026-10-01T12:00:00Z',42,123)`);
			const before = await client.unsafe('SELECT * FROM kills');
			const clocks = await client.unsafe('SELECT * FROM feed_clocks');
			const ledger = await client.unsafe('SELECT * FROM feed_events');
			await runMigrations(db, 'drizzle');
			expect(await pendingMigrations(db, 'drizzle')).toBe(0);
			expect(await client.unsafe('SELECT * FROM kills')).toEqual(before);
			expect(await client.unsafe('SELECT * FROM feed_clocks')).toEqual(clocks);
			expect(await client.unsafe('SELECT * FROM feed_events')).toEqual(ledger);
			const [totals] = await client.unsafe('SELECT * FROM player_totals');
			expect({
				...totals,
				seconds: Number(totals.seconds),
				cash: Number(totals.cash),
				seed_seconds: Number(totals.seed_seconds)
			}).toMatchObject({
				server_id: 'old-server',
				steam_id: 'player',
				sessions: 1,
				seconds: 3600,
				cash: 42,
				seed_seconds: 123
			});
			const indexes = await client.unsafe(`SELECT indexname FROM pg_indexes
				WHERE indexname IN ('matches_open_idx','audit_target_idx','list_entries_expiry_idx')`);
			expect(indexes).toHaveLength(3);
			const applied = await client.unsafe('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id');
			expect(applied).toHaveLength(40);
			await runMigrations(db, 'drizzle');
			expect(await client.unsafe('SELECT * FROM drizzle.__drizzle_migrations ORDER BY id')).toEqual(
				applied
			);
			expect(await client.unsafe('SELECT * FROM kills')).toEqual(before);
			expect(await client.unsafe('SELECT * FROM feed_events')).toEqual(ledger);
		} finally {
			await client.close();
			await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
			await admin.close();
			await rm(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
