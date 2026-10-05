// A rule's kill against a stand-in game: the kill, then the whisper, and what became of it in fixed
// words, never the game's.
import { describe, expect, test } from 'bun:test';
import { GameError, WardogsClient } from './rcon';
import { killAndTell, RULE_KILL } from './rule-kill';
import { ACTIONS } from './actions';

const A = '76561198000000001';
const params = { steamId: A, name: '[ABC] Night Owl', why: 'Humvee kill', message: 'No Humvees.' };
/** what the game says in its answers; none of it may reach the outcome */
const GAME = 'GAME-TEXT';

type Answer = { status: number; body: unknown; headers?: Record<string, string> };
/** A client whose game answers the kill and the whisper as told, and keeps what it was sent. */
function game(kill: Answer, whisper: Answer = { status: 200, body: { message: GAME } }) {
	const sent: [string, unknown][] = [];
	const client = new WardogsClient(
		{} as never,
		{ id: 'rule-kill', host: 'demo', port: 1, scheme: 'http' },
		'demo',
		'rule-kill'
	);
	client.raw = async (method, path, body) => {
		const answer = path.endsWith('/kill') ? kill : whisper;
		sent.push([`${method} ${path}`, body ? JSON.parse(body) : null]);
		return {
			status: answer.status,
			statusText: '',
			headers: { 'content-type': 'application/json', ...answer.headers },
			text: JSON.stringify(answer.body)
		};
	};
	return { client, sent };
}
const refused = (status: number, code: string) => ({
	status,
	body: { error: { code, message: GAME } }
});

describe('killAndTell', () => {
	test('is no game action: no route can run it', () => {
		expect(ACTIONS[RULE_KILL]).toBeUndefined();
	});
	test('kills the player, then whispers them the text', async () => {
		const { client, sent } = game({ status: 200, body: { message: GAME } });
		const r = await killAndTell(client, params);
		expect(sent).toEqual([
			[`POST /v1/players/${A}/kill`, null],
			[`POST /v1/players/${A}/message`, { message: 'No Humvees.' }]
		]);
		expect(r).toEqual({ message: 'Killed [ABC] Night Owl: Humvee kill' });
	});
	test('a kill the game refuses otherwise (no living character, presumably) still tells them', async () => {
		const { client, sent } = game(refused(409, 'not_alive'));
		const r = await killAndTell(client, params);
		expect(sent.map(([what]) => what)).toEqual([
			`POST /v1/players/${A}/kill`,
			`POST /v1/players/${A}/message`
		]);
		expect(r.message).toBe('Told [ABC] Night Owl, but the game refused the kill: Humvee kill');
	});
	test('a kill refused as no such player is told all the same; with the whisper refused too, they are gone', async () => {
		const missing = refused(404, 'player_not_found');
		const dead = game(missing);
		expect((await killAndTell(dead.client, params)).message).toBe(
			'Told [ABC] Night Owl, but the game refused the kill: Humvee kill'
		);
		expect(dead.sent).toHaveLength(2);
		const gone = game(missing, missing);
		const err = await killAndTell(gone.client, params).catch((e) => e);
		expect(err).toBeInstanceOf(GameError);
		expect([(err as GameError).code, gone.sent.length]).toEqual(['player_not_found', 2]);
		// nothing to tell: the kill's refusal stands
		const quiet = game(missing);
		const none = await killAndTell(quiet.client, { ...params, message: '' }).catch((e) => e);
		expect([(none as GameError).code, quiet.sent.length]).toEqual(['player_not_found', 1]);
	});
	test('a refusal for sending too fast, a refused password or a server error stops it before the whisper', async () => {
		for (const [answer, code] of [
			[{ ...refused(429, 'rate_limited'), headers: { 'retry-after': '7' } }, 'rate_limited'],
			[refused(401, 'unauthorized'), 'unauthorized'],
			[refused(500, 'internal'), 'internal']
		] as const) {
			const { client, sent } = game(answer);
			const err = await killAndTell(client, params).catch((e) => e);
			expect(err).toBeInstanceOf(GameError);
			expect([code, (err as GameError).code]).toEqual([code, code]);
			expect(sent).toHaveLength(1);
		}
	});
	test('a whisper not sent leaves the kill done, one refused for sending too fast carrying the wait; with the kill refused too, the row fails', async () => {
		const ok = { status: 200, body: { message: GAME } };
		const quiet = await killAndTell(game(ok, refused(400, 'bad_request')).client, params);
		expect(quiet).toEqual({ message: 'Killed [ABC] Night Owl: Humvee kill (not told)' });
		const slow = await killAndTell(
			game(ok, { ...refused(429, 'rate_limited'), headers: { 'retry-after': '7' } }).client,
			params
		);
		expect(slow).toEqual({
			message:
				'Killed [ABC] Night Owl: Humvee kill (not told: the server asked the panel to slow down)',
			retryAfterMs: 7000
		});
		// both refused: nothing was done, so the row fails, as the whisper's refusal when the game
		// asked the panel to slow down (the server is then held), else as the kill's
		const neither = await killAndTell(
			game(refused(409, 'not_alive'), refused(400, 'bad_request')).client,
			params
		).catch((e) => e);
		expect((neither as GameError).code).toBe('not_alive');
		const neitherSlow = await killAndTell(
			game(refused(409, 'not_alive'), {
				...refused(429, 'rate_limited'),
				headers: { 'retry-after': '7' }
			}).client,
			params
		).catch((e) => e);
		expect([(neitherSlow as GameError).code, (neitherSlow as GameError).retryAfterMs]).toEqual([
			'rate_limited',
			7000
		]);
		for (const r of [quiet, slow]) expect(r.message).not.toContain(GAME);
	});
});
