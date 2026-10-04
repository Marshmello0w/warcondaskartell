// The Audit page's filter lists. The site owner's come from stepping through the indexes one value
// at a time; they must hold what the per-caller lists hold for the same rows: each action once with
// its latest row's category, each actor once with the name on their latest row.
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import type { Env } from '$lib/server/env';
import { auditMeta } from '$lib/server/audit';
import { auditLog } from '$lib/server/db/schema';
import { hasTestDb, testEnv } from './db';

describe.skipIf(!hasTestDb)('audit filter lists', () => {
	let env: Env;
	const t = randomBytes(4).toString('hex');
	const actor = `u_meta_${t}`;
	const other = `u_meta_other_${t}`;
	const refiled = `meta.refiled.${t}`;
	const plain = `meta.plain.${t}`;

	beforeAll(async () => {
		env = await testEnv();
		// One at a time, so ids ascend in this order and the later rows are the latest.
		for (const [actorId, actorName, category, action] of [
			[actor, 'old name', 'oldcategory', refiled],
			[other, 'someone', 'server', plain],
			[actor, 'new name', 'newcategory', refiled]
		])
			await env.db.insert(auditLog).values({ actorId, actorName, category, action, outcome: 'ok' });
	});

	test('the site owner sees each action once under its latest category, each actor once by their latest name', async () => {
		const all = await auditMeta(env, null);
		expect(all.actions.filter((a) => a.action === refiled)).toEqual([
			{ category: 'newcategory', action: refiled }
		]);
		expect(all.actions.filter((a) => a.action === plain)).toEqual([
			{ category: 'server', action: plain }
		]);
		expect(all.actors.filter((a) => a.actorId === actor)).toEqual([
			{ actorId: actor, actorName: 'new name' }
		]);
		expect(all.actors.filter((a) => a.actorId === other)).toEqual([
			{ actorId: other, actorName: 'someone' }
		]);
	});

	test('the per-caller lists give the same rows for what the caller may see', async () => {
		const mine = await auditMeta(env, { userId: actor, adminServerIds: [], ownedOrgIds: [] });
		const all = await auditMeta(env, null);
		expect(mine.actions).toEqual(all.actions.filter((a) => a.action === refiled));
		expect(mine.actors).toEqual(all.actors.filter((a) => a.actorId === actor));
	});
});
