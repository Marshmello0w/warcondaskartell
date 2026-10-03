// An org's owners put its roles in their own order: the columns of the roles page and every role
// picker follow it. The order is display only, written whole, and refused when it does not name
// each of the org's roles once.
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { auditLog, orgRoles } from '$lib/server/db/schema';
import { lockRoleOrder, rolesByOrg } from '$lib/server/roles';
import { GET as listRoute, POST as createRoute } from '../routes/api/orgs/[id]/roles/+server';
import { PUT as orderRoute } from '../routes/api/orgs/[id]/roles/order/+server';
import { hasTestDb, testEnv } from './db';
import { callApi } from './call';
import { seedWorld, type World } from './world';

describe.skipIf(!hasTestDb)('role order', () => {
	let env: Env;

	beforeAll(async () => {
		env = await testEnv();
	});

	const idsOf = async (w: World): Promise<string[]> => {
		const got = await callApi(listRoute, w.users.owner, { params: { id: w.org.id } });
		expect(got.status).toBe(200);
		return (got.body as { roles: { id: string }[] }).roles.map((r) => r.id);
	};
	const put = (w: World, ids: unknown, who: keyof World['users'] = 'owner') =>
		callApi(orderRoute, w.users[who], {
			method: 'PUT',
			params: { id: w.org.id },
			body: { ids }
		});
	const namesOf = async (w: World, ids: string[]) => {
		const byId = new Map(
			(
				await env.db
					.select({ id: orgRoles.id, name: orgRoles.name })
					.from(orgRoles)
					.where(eq(orgRoles.orgId, w.org.id))
			).map((r) => [r.id, r.name])
		);
		return ids.map((id) => byId.get(id));
	};
	const audits = (w: World) =>
		env.db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.action, 'org.role.reorder')));

	test('an owner sets the order, and every list of the roles follows it', async () => {
		const w = await seedWorld(env);
		const order = (await idsOf(w)).reverse();
		const got = await put(w, order);
		expect(got.status).toBe(200);
		expect((got.body as { roles: { id: string }[] }).roles.map((r) => r.id)).toEqual(order);
		expect(await idsOf(w)).toEqual(order);
		expect((await rolesByOrg(env, [w.org.id]))[w.org.id].map((r) => r.id)).toEqual(order);
		const rows = await env.db
			.select({ id: orgRoles.id, n: orgRoles.sortOrder })
			.from(orgRoles)
			.where(eq(orgRoles.orgId, w.org.id));
		expect(Object.fromEntries(rows.map((r) => [r.id, r.n]))).toEqual(
			Object.fromEntries(order.map((id, i) => [id, i]))
		);
	});

	test('a list that does not name every role once is refused, and nothing moves', async () => {
		const w = await seedWorld(env);
		const before = await idsOf(w);
		const [theirs] = await env.db
			.select({ id: orgRoles.id })
			.from(orgRoles)
			.where(eq(orgRoles.orgId, w.otherOrg.id))
			.limit(1);
		const stale = [
			before.slice(1), // a role left out (made since the list was read)
			[...before, theirs.id], // another org's role added
			[...before.slice(1), theirs.id], // another org's role in place of one of ours
			[before[0], before[0], ...before.slice(2)], // one named twice in place of another
			[...before, before[0]], // one named twice, the rest all there
			[]
		];
		for (const ids of stale) {
			const got = await put(w, ids);
			expect([got.status, got.code]).toEqual([409, 'stale']);
		}
		for (const ids of [undefined, 'viewer', [1, 2, 3], [...before.slice(1), null], {}]) {
			const got = await put(w, ids);
			expect(got.status).toBe(400);
		}
		expect(await idsOf(w)).toEqual(before);
		expect(await audits(w)).toHaveLength(0);
	});

	test('a new role goes in last', async () => {
		const w = await seedWorld(env);
		const order = (await idsOf(w)).reverse();
		expect((await put(w, order)).status).toBe(200);
		const made = await callApi(createRoute, w.users.owner, {
			method: 'POST',
			params: { id: w.org.id },
			body: { name: 'Trial staff', capabilities: ['server.view'] }
		});
		expect(made.status).toBe(201);
		const id = (made.body as { role: { id: string } }).role.id;
		expect(await idsOf(w)).toEqual([...order, id]);
	});

	test('a new role goes in last in an org whose custom roles all sat at 100', async () => {
		const w = await seedWorld(env);
		await env.db
			.update(orgRoles)
			.set({ sortOrder: 100 })
			.where(and(eq(orgRoles.orgId, w.org.id), isNull(orgRoles.builtin)));
		const before = await idsOf(w);
		const made = await callApi(createRoute, w.users.owner, {
			method: 'POST',
			params: { id: w.org.id },
			body: { name: 'A first by name', capabilities: ['server.view'] }
		});
		expect(made.status).toBe(201);
		expect(await idsOf(w)).toEqual([...before, (made.body as { role: { id: string } }).role.id]);
	});

	test('sending the order an org already shows writes its places as 0..n, unaudited', async () => {
		const w = await seedWorld(env);
		await env.db
			.update(orgRoles)
			.set({ sortOrder: 100 })
			.where(and(eq(orgRoles.orgId, w.org.id), isNull(orgRoles.builtin)));
		const before = await idsOf(w);
		expect((await put(w, before)).status).toBe(200);
		expect(await idsOf(w)).toEqual(before);
		const rows = await env.db
			.select({ id: orgRoles.id, n: orgRoles.sortOrder })
			.from(orgRoles)
			.where(eq(orgRoles.orgId, w.org.id));
		expect(Object.fromEntries(rows.map((r) => [r.id, r.n]))).toEqual(
			Object.fromEntries(before.map((id, i) => [id, i]))
		);
		expect(await audits(w)).toHaveLength(0);
	});

	test('a change of order is audited; resending the same order is not', async () => {
		const w = await seedWorld(env);
		const before = await idsOf(w);
		expect((await put(w, before)).status).toBe(200);
		expect(await audits(w)).toHaveLength(0);
		const after = [before[1], before[0], ...before.slice(2)];
		expect((await put(w, after)).status).toBe(200);
		expect((await put(w, after)).status).toBe(200);
		const rows = await audits(w);
		expect(rows).toHaveLength(1);
		expect(rows[0].detail).toEqual({
			orgId: w.org.id,
			from: await namesOf(w, before),
			to: await namesOf(w, after)
		});
		expect(rows[0].actorId).toBe(w.users.owner!.id);
	});

	/**
	 * Another owner's request in flight: holds the org's order lock and the role rows (what a
	 * reorder holds, then and now), optionally having reversed the order, without committing,
	 * while `during` starts and runs into it. Commits once `waiters` requests wait on a lock, or
	 * once `during` has finished without waiting (as a create did before the order lock).
	 */
	async function whileHeld<T>(
		w: World,
		reverse: boolean,
		during: () => Promise<T>,
		waiters = 1
	): Promise<T> {
		let pending!: Promise<T>;
		await env.db.transaction(async (tx) => {
			await lockRoleOrder(tx, w.org.id);
			const rows = await tx
				.select()
				.from(orgRoles)
				.where(eq(orgRoles.orgId, w.org.id))
				.orderBy(asc(orgRoles.sortOrder), asc(orgRoles.name))
				.for('update');
			if (reverse)
				for (const [i, r] of [...rows].reverse().entries())
					await tx.update(orgRoles).set({ sortOrder: i }).where(eq(orgRoles.id, r.id));
			let done = false;
			pending = during();
			pending.then(
				() => (done = true),
				() => (done = true)
			);
			for (let i = 0; i < 250 && !done; i++) {
				const [row] = await env.db.execute<{ n: number }>(
					sql`SELECT count(*)::int AS n FROM pg_stat_activity
						WHERE datname = current_database() AND wait_event_type = 'Lock'`
				);
				if (Number(row.n) >= waiters) break;
				await Bun.sleep(20);
			}
		});
		return pending;
	}
	const create = (w: World, name: string) =>
		callApi(createRoute, w.users.owner, {
			method: 'POST',
			params: { id: w.org.id },
			body: { name, capabilities: ['server.view'] }
		});

	test('a reorder that waited for another is audited against the order it found', async () => {
		const w = await seedWorld(env);
		const before = await idsOf(w);
		const reversed = [...before].reverse();
		// read `before`, sent `before` while another owner's reversal was being saved: it undoes it
		const got = await whileHeld(w, true, () => put(w, before));
		expect(got.status).toBe(200);
		expect(await idsOf(w)).toEqual(before);
		const rows = await audits(w);
		expect(rows.map((r) => r.detail)).toEqual([
			{ orgId: w.org.id, from: await namesOf(w, reversed), to: await namesOf(w, before) }
		]);
	});

	test('a role made while a reorder is being saved still goes in last', async () => {
		const w = await seedWorld(env);
		const made = await whileHeld(w, true, () => create(w, 'A first by name'));
		expect(made.status).toBe(201);
		expect((await idsOf(w)).at(-1)).toBe((made.body as { role: { id: string } }).role.id);
	});

	test('two roles made at once take places of their own', async () => {
		const w = await seedWorld(env);
		const made = await whileHeld(
			w,
			false,
			() => Promise.all([create(w, 'First new'), create(w, 'Second new')]),
			2
		);
		expect(made.map((m) => m.status)).toEqual([201, 201]);
		const places = made.map((m) => (m.body as { role: { sortOrder: number } }).role.sortOrder);
		expect(new Set(places).size).toBe(2);
	});

	test('two roles made at once with one name: the second is told the name is taken', async () => {
		const w = await seedWorld(env);
		const made = await whileHeld(
			w,
			false,
			() => Promise.all([create(w, 'Same name'), create(w, 'same NAME')]),
			2
		);
		expect(made.map((m) => [m.status, m.code]).sort()).toEqual([
			[201, ''],
			[409, 'conflict']
		]);
	});

	test('nobody but an owner of the org moves its roles', async () => {
		const w = await seedWorld(env);
		const before = await idsOf(w);
		const order = [...before].reverse();
		const got: Record<string, number> = {};
		for (const who of ['admin', 'viewer', 'outsider', 'keyAll', 'anon'] as const)
			got[who] = (await put(w, order, who)).status;
		expect(got).toEqual({ admin: 403, viewer: 403, outsider: 404, keyAll: 403, anon: 401 });
		expect(await idsOf(w)).toEqual(before);
	});
});
