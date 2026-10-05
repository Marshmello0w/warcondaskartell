import { describe, expect, test } from 'bun:test';
import { clanTeamsStep, validateClanTeams } from './clan-teams';
import { emptyTwoTeamsState, type TwoTeamsState } from './two-teams';

const R = 'Manticore',
	G = 'Valkyra',
	B = 'Lonestar';
const factions = [R, G, B];
const cfg = validateClanTeams({});
const p = (id: string, faction: string | null, name = `[ichbins] ${id}`) => ({
	steamId: id,
	name,
	faction
});
const step = (
	state: TwoTeamsState,
	players: ReturnType<typeof p>[],
	now = 0,
	max = 6,
	watchOnly = false
) => clanTeamsStep({ watchOnly }, state, players, factions, now, max);

describe('Clan teams without team balance', () => {
	test('the first pick wins, even when the later player is first in the next roster', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R)]);
		const next = step(first.state, [p('b', G), p('a', R)], 1000);
		expect(next.moves).toEqual([
			{ steamId: 'b', name: '[ichbins] b', from: G, to: R, why: 'clan' }
		]);
		expect(next.whispers).toEqual([]);
	});
	test('only tagged clanmates move, even onto a much larger team or onto Blue', () => {
		const list = [
			p('a', B),
			...Array.from({ length: 30 }, (_, i) => p(`x${i}`, B, `Solo ${i}`)),
			p('solo', G, 'Solo'),
			p('b', R)
		];
		const result = step(emptyTwoTeamsState(), list);
		expect(result.moves.map((m) => [m.steamId, m.to])).toEqual([['b', B]]);
	});
	test('a lone tagged player may change teams; an unpicked member does not set the side', () => {
		const first = step(emptyTwoTeamsState(), [p('b', R)]);
		const switched = step(first.state, [p('b', G)], 1000);
		expect(switched.moves).toEqual([]);
		const withUnpicked = step(switched.state, [p('a', null), p('b', G)], 1500);
		expect(
			step(withUnpicked.state, [p('a', R), p('b', G)], 2000).moves.map((m) => [m.steamId, m.to])
		).toEqual([['a', G]]);
	});
	test('a member temporarily without a faction does not let a follower take over the clan side', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R), p('b', G)]);
		const menu = step(first.state, [p('a', null), p('b', G)], 15_000);
		expect(menu.moves.map((m) => [m.steamId, m.to])).toEqual([['b', R]]);
	});
	test('tags ignore case and bracket style; different tags and suffixes stay separate', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R)]);
		const result = step(
			first.state,
			[
				p('a', R),
				p('b', G, '{ICHBINS} B'),
				p('c', B, '(ichbins) C'),
				p('other', B, '[other] O'),
				p('suffix', G, 'S [ichbins]')
			],
			1000
		);
		expect(result.moves.map((m) => m.steamId)).toEqual(['b', 'c']);
	});
	test('a follower switching later is restored; existing clanmates are not shifted', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R), p('b', R)]);
		expect(step(first.state, [p('b', G), p('a', R)], 1000).moves.map((m) => m.steamId)).toEqual([
			'b'
		]);
	});
	test('a refused move retries at 15 seconds, and ten asks pause until the rolling window opens', () => {
		const players = [p('a', R), p('b', G)];
		let result = step(emptyTwoTeamsState(), players);
		expect(step(result.state, players, 14_999).moves).toEqual([]);
		for (let n = 1; n < 10; n++) {
			result = step(result.state, players, n * 15_000);
			expect(result.moves).toHaveLength(1);
		}
		result = step(result.state, players, 150_000);
		expect(result.moves).toEqual([]);
		expect(result.stopped.map((m) => m.steamId)).toEqual(['b']);
		expect(step(result.state, players, 599_999).moves).toEqual([]);
		expect(step(result.state, players, 600_000).moves).toHaveLength(1);
	});
	test('brief landings do not bypass the retry interval or reset the budget', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R), p('b', G)]);
		const landed = step(first.state, [p('a', R), p('b', R)], 1000);
		const wrong = step(landed.state, [p('a', R), p('b', G)], 2000);
		expect(wrong.moves).toEqual([]);
		expect(wrong.state.asked.get('b')).toEqual([0]);
		const again = step(wrong.state, [p('a', R), p('b', G)], 15_000);
		const stable = step(again.state, [p('a', R), p('b', R)], 20_000);
		expect(step(stable.state, [p('a', R), p('b', R)], 49_999).state.asked.has('b')).toBe(true);
		expect(step(stable.state, [p('a', R), p('b', R)], 50_000).state.asked.has('b')).toBe(false);
	});
	test('the clan side survives its first member leaving while other members remain', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R), p('b', R), p('c', G)]);
		const result = step(first.state, [p('c', G), p('b', R)], 15_000);
		expect(result.moves.map((m) => [m.steamId, m.to])).toEqual([['c', R]]);
	});
	test('when only one remains, their pending move is cancelled and they may choose freely', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R), p('b', G)]);
		const result = step(first.state, [p('b', G)], 15_000);
		expect(result.moves).toEqual([]);
		expect(result.state.moving.has('b')).toBe(false);
	});
	test('the clan may choose again after everyone leaves or the next match starts', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R), p('b', R)]);
		const absent = step(first.state, [], 1000);
		expect(step(absent.state, [p('a', G), p('b', G)], 2000).moves).toEqual([]);
		const nextMatch = clanTeamsStep(cfg, first.state, [p('b', G), p('a', R)], factions, 1000, 6, {
			newMatch: true
		});
		expect(nextMatch.moves.map((m) => [m.steamId, m.to])).toEqual([['a', G]]);
	});
	test('renaming out of a clan cancels its move and unknown factions are left alone', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R), p('b', G)]);
		const renamed = step(
			first.state,
			[p('a', R), p('b', G, 'Solo'), p('unknown', 'Menu'), p('null', null)],
			1000
		);
		expect(renamed.moves).toEqual([]);
		expect(renamed.state.moving.size).toBe(0);
	});
	test('a small move budget prioritizes new placements over retries and preserves its input', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R), p('b', G)], 0, 1);
		const result = step(first.state, [p('a', R), p('b', G), p('c', B)], 15_000, 1);
		expect(result.moves.map((m) => m.steamId)).toEqual(['c']);
		expect(first.state.asked.get('b')).toEqual([0]);
		expect(first.state.asked.has('c')).toBe(false);
	});
	test('watch-only records each placement once, without using the real retry budget', () => {
		const players = [p('a', R), p('b', G)];
		const first = step(emptyTwoTeamsState(), players, 0, 6, true);
		expect(first.moves).toHaveLength(1);
		expect(first.state.moving.size).toBe(0);
		expect(first.state.asked.size).toBe(0);
		expect(step(first.state, players, 1000, 6, true).moves).toEqual([]);
	});
	test('only a confirmed landing notifies both players, keeping the original leader across retries and reorderings', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R)]);
		const move = step(first.state, [p('b', G), p('a', R)], 1000);
		const retry = step(move.state, [p('b', G), p('a', R)], 16_000);
		expect(move.whispers).toEqual([]);
		expect(retry.whispers).toEqual([]);
		const landed = step(retry.state, [p('b', R), p('a', R)], 21_000);
		expect(landed.whispers).toEqual([
			{
				steamId: 'b',
				name: '[ichbins] b',
				faction: R,
				clan: { tag: 'ichbins', movedSteamId: 'b', movedName: '[ichbins] b' }
			},
			{
				steamId: 'a',
				name: '[ichbins] a',
				faction: R,
				clan: { tag: 'ichbins', movedSteamId: 'b', movedName: '[ichbins] b' }
			}
		]);
		expect(step(landed.state, [p('b', R), p('a', R)], 26_000).whispers).toEqual([]);
		// A later switch is a new placement, not a retry of the old one.
		const switched = step(landed.state, [p('b', G), p('a', R)], 31_000);
		expect(step(switched.state, [p('b', R), p('a', R)], 36_000).whispers).toHaveLength(2);
		expect(step(move.state, [p('b', R), p('a', R)], 6000).whispers).toHaveLength(2);
	});
	test('a temporary faction-less roster keeps the notice but a rename or match boundary cancels it', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R), p('b', G)]);
		const menu = step(first.state, [p('a', R), p('b', null)], 5000);
		expect(step(menu.state, [p('a', R), p('b', R)], 10_000).whispers).toHaveLength(2);
		const renamed = step(first.state, [p('a', R), p('b', R, '[other] B')], 5000);
		expect(renamed.whispers).toEqual([]);
		expect(
			clanTeamsStep(cfg, first.state, [p('a', R), p('b', R)], factions, 5000, 6, { newMatch: true })
				.whispers
		).toEqual([]);
	});
	test('no notice goes to an absent, renamed or differently placed leader', () => {
		const first = step(emptyTwoTeamsState(), [p('a', R), p('b', R), p('c', G)]);
		for (const leader of [null, p('a', R, '[other] A'), p('a', G)]) {
			const result = step(first.state, [...(leader ? [leader] : []), p('b', R), p('c', R)], 5000);
			expect(result.whispers.map((w) => w.steamId)).toEqual(['c']);
		}
		const departed = step(first.state, [p('b', R), p('c', G)], 5000);
		const later = step(departed.state, [p('b', R), p('c', G), p('d', B)], 10_000);
		expect(
			step(later.state, [p('b', R), p('c', G), p('d', R)], 15_000).whispers.map((w) => w.steamId)
		).toEqual(['d', 'b']);
	});
	test('existing clanmates and watch-only landings are never announced', () => {
		expect(step(emptyTwoTeamsState(), [p('a', R), p('b', R)]).whispers).toEqual([]);
		const watched = step(emptyTwoTeamsState(), [p('a', R), p('b', G)], 0, 6, true);
		expect(step(watched.state, [p('a', R), p('b', R)], 5000, 6, true).whispers).toEqual([]);
		const first = step(emptyTwoTeamsState(), [p('a', R), p('b', G)]);
		expect(step(first.state, [p('b', R)], 5000).whispers).toEqual([]);
	});
});
