// A Two-team mode sort is a hundred moves at every match start: the audit trail keeps each, and the
// org's Automation webhook hears only of the ones that fail. Other rules post as before.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { auditLog, webhooks } from '$lib/server/db/schema';
import { writeAudit } from '$lib/server/audit';
import { encryptSecret } from '$lib/server/crypto';
import { newId } from '$lib/server/http';
import { resetWebhookQueues } from '$lib/server/webhook-delivery';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

describe.skipIf(!hasTestDb)('Two-team mode on Discord', () => {
	let env: Env;
	let w: World;
	const posts: string[] = [];
	const realFetch = globalThis.fetch;

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		await env.db.insert(webhooks).values({
			id: newId(),
			orgId: w.org.id,
			label: 'automation',
			urlEnc: encryptSecret(env, 'https://discord.test/api/webhooks/1/automation'),
			events: ['triggers'],
			serverIds: null
		});
		globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
			posts.push(String(init?.body ?? ''));
			return new Response('{"id":"1"}', { status: 200 });
		}) as typeof fetch;
	});

	afterAll(() => {
		globalThis.fetch = realFetch;
		resetWebhookQueues();
	});

	const delivery = (action: string, outcome: 'ok' | 'error', message: string) =>
		writeAudit(env, null, {
			actorName: 'trigger: rule',
			server: { id: w.server.id, name: 'Server' },
			orgId: w.org.id,
			category: 'trigger',
			action,
			target: '76561198000000951',
			outcome,
			message
		});

	test('moves that land stay off Discord; one that fails, and other rules, are posted', async () => {
		posts.length = 0;
		for (let i = 0; i < 20; i++) await delivery('trigger.two_teams', 'ok', 'Moved to Valkyra.');
		await delivery('trigger.two_teams', 'error', 'The player is not on the server.');
		await delivery('trigger.welcome', 'ok', 'Whispered.');
		await new Promise((r) => setTimeout(r, 2000));
		const titles = posts.flatMap((body) =>
			(JSON.parse(body) as { embeds: { title: string }[] }).embeds.map((e) => e.title)
		);
		expect(titles).toEqual(['Trigger · two-team mode', 'Trigger · welcome whisper']);
		const kept = await env.db
			.select({ outcome: auditLog.outcome })
			.from(auditLog)
			.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.action, 'trigger.two_teams')));
		expect(kept).toHaveLength(21);
	});
});
