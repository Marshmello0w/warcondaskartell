import { expect, test } from 'bun:test';
import { call, LIVE_GET_IDS, remoteLive } from './gateway-remote';
import type { Env } from './env';

test('a worker that cannot be reached is said plainly: the runtime quotes the relay URL in some failures', async () => {
	const notHttp = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			data(socket) {
				socket.end('not http at all\r\n\r\n');
			}
		}
	});
	const env = {
		RELAY_URL: `http://127.0.0.1:${notHttp.port}`,
		RELAY_SECRET: 'x'.repeat(16)
	} as Env;
	const logged = console.error;
	console.error = () => {};
	try {
		const failure = await call(env, '/health', undefined, 'GET', 2000).catch((e: Error) => e);
		expect((failure as Error).message).toBe('The worker is not reachable.');
	} finally {
		console.error = logged;
		notHttp.stop(true);
	}
});

test('the worker is asked for a short list of live views in the URL and for a long one in the body', async () => {
	const seen: { method: string; ids: string | null; body: unknown }[] = [];
	const worker = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			seen.push({
				method: req.method,
				ids: url.searchParams.get('ids'),
				body: req.method === 'POST' ? await req.json() : null
			});
			return Response.json({ ok: true, result: {} });
		}
	});
	const env = { RELAY_URL: `http://127.0.0.1:${worker.port}`, RELAY_SECRET: 'x'.repeat(16) } as Env;
	try {
		const few = ['a', 'b', 'c'];
		const many = Array.from({ length: LIVE_GET_IDS + 1 }, (_, i) => `server-${i}`);
		await remoteLive(env, few);
		await remoteLive(env, many);
		expect(seen).toEqual([
			{ method: 'GET', ids: 'a,b,c', body: null },
			{ method: 'POST', ids: null, body: { ids: many } }
		]);
	} finally {
		worker.stop(true);
	}
});
