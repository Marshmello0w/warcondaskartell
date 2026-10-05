// Clan grouping alone: the first observed faction pick sets a clan's side. Other members follow,
// without closing a faction or balancing team sizes. The team-move delivery protocol is shared
// with Two-team mode so retries and stale queued moves have the same safeguards.
import { settingsFingerprint } from './fingerprint';
import {
	clanTag,
	emptyTwoTeamsState,
	TWO_TEAMS_ASK_WINDOW_MS,
	TWO_TEAMS_MAX_ASKS,
	TWO_TEAMS_RETRY_MS,
	TWO_TEAMS_SETTLED_MS,
	type TwoTeamsConfig,
	type TwoTeamsLook,
	type TwoTeamsState,
	type TwoTeamsStep
} from './two-teams';

export const CLAN_TEAMS_PLAYERS_MS = 5_000;
export interface ClanTeamsConfig {
	watchOnly: boolean;
}
export const validateClanTeams = (c: Record<string, unknown>): ClanTeamsConfig => ({
	watchOnly: c.watchOnly === true
});
export const clanTeamsSettingsKey = (c: ClanTeamsConfig): string => settingsFingerprint(c);
/** Delivery uses the same move pipeline; clan grouping never balances. */
export const clanTeamsMoveConfig = (c: ClanTeamsConfig): TwoTeamsConfig => ({
	closedFaction: '',
	names: {},
	message: '',
	watchOnly: c.watchOnly
});
interface ClanTeamsState extends TwoTeamsState {
	clanSides: Map<string, string>;
	clanMembers: Map<string, string>;
	/** Whoever established the side, independent of later roster ordering. */
	clanLeaders: Map<string, string>;
	/** One notice per placement, retained across failed attempts and brief faction-less looks. */
	clanNotices: Map<string, { tag: string; faction: string; leader: string | null }>;
}
type Member = { steamId: string; name: string; faction: string | null };

export function clanTeamsStep(
	cfg: ClanTeamsConfig,
	previous: TwoTeamsState,
	players: readonly Member[],
	factions: readonly string[],
	now: number,
	maxMoves: number,
	look: TwoTeamsLook = {}
): TwoTeamsStep {
	const old = previous as Partial<ClanTeamsState>;
	const state: ClanTeamsState = {
		...emptyTwoTeamsState(),
		moving: new Map(previous.moving),
		asked: new Map(
			[...previous.asked].map(([id, asks]) => [
				id,
				asks.filter((at) => now - at < TWO_TEAMS_ASK_WINDOW_MS)
			])
		),
		capped: new Set(previous.capped),
		openSince: new Map(previous.openSince),
		would: new Map(previous.would),
		clanSides: new Map(old.clanSides),
		clanMembers: new Map(),
		clanLeaders: new Map(old.clanLeaders),
		clanNotices: new Map(old.clanNotices)
	};
	const result: TwoTeamsStep = { state, moves: [], whispers: [], stopped: [] };
	if (look.newMatch) {
		state.clanSides.clear();
		state.clanLeaders.clear();
		state.clanNotices.clear();
		state.moving.clear();
		state.openSince.clear();
		state.would.clear();
	}
	const valid = new Set(factions.filter(Boolean));
	const groups = new Map<string, Member[]>();
	const listed = new Map(players.map((p) => [p.steamId, p]));
	for (const p of players) {
		const tag = clanTag(p.name);
		if (!tag) continue;
		state.clanMembers.set(p.steamId, tag);
		const group = groups.get(tag) ?? [];
		group.push(p);
		groups.set(tag, group);
	}
	for (const [tag, side] of state.clanSides)
		if (!groups.has(tag) || !valid.has(side)) state.clanSides.delete(tag);
	for (const [id, virtual] of state.would)
		if (
			!state.clanMembers.has(id) ||
			old.clanMembers?.get(id) !== state.clanMembers.get(id) ||
			listed.get(id)?.faction !== virtual.from
		)
			state.would.delete(id);
	const sideOf = (p: Member): string | null =>
		cfg.watchOnly ? (state.would.get(p.steamId)?.to ?? p.faction) : p.faction;
	for (const [tag, group] of groups) {
		const picked = group.filter((p) => valid.has(sideOf(p) ?? ''));
		const first = picked[0];
		if (!first) continue;
		// A lone member may pick any side. Once another member picks, the established side stays
		// until the clan leaves or the next match; a follower cannot pull the first member away.
		if (group.length === 1) {
			state.would.delete(first.steamId);
			state.clanSides.set(tag, first.faction!);
			state.clanLeaders.set(tag, first.steamId);
		} else if (!state.clanSides.has(tag)) {
			state.clanSides.set(tag, sideOf(first)!);
			state.clanLeaders.set(tag, first.steamId);
		}
	}
	for (const [tag, id] of state.clanLeaders)
		if (!state.clanSides.has(tag) || state.clanMembers.get(id) !== tag)
			state.clanLeaders.delete(tag);
	// When the first member leaves, an existing clanmate on the established side can receive
	// later arrivals' notices. The side itself remains unchanged.
	for (const [tag, group] of groups) {
		if (state.clanLeaders.has(tag)) continue;
		const leader = group.find((p) => p.faction === state.clanSides.get(tag));
		if (leader) state.clanLeaders.set(tag, leader.steamId);
	}
	for (const [id, notice] of state.clanNotices) {
		const p = listed.get(id);
		if (
			cfg.watchOnly ||
			!p ||
			state.clanMembers.get(id) !== notice.tag ||
			(groups.get(notice.tag)?.length ?? 0) < 2 ||
			state.clanSides.get(notice.tag) !== notice.faction
		) {
			state.clanNotices.delete(id);
			continue;
		}
		if (p.faction !== notice.faction) continue;
		const clan = { tag: notice.tag, movedSteamId: id, movedName: p.name };
		result.whispers.push({ steamId: id, name: p.name, faction: notice.faction, clan });
		const leader = notice.leader ? listed.get(notice.leader) : undefined;
		if (
			leader &&
			leader.steamId !== id &&
			state.clanMembers.get(leader.steamId) === notice.tag &&
			leader.faction === notice.faction
		)
			result.whispers.push({
				steamId: leader.steamId,
				name: leader.name,
				faction: notice.faction,
				clan
			});
		state.clanNotices.delete(id);
	}
	for (const [id, move] of state.moving) {
		const p = listed.get(id);
		const tag = state.clanMembers.get(id);
		if (
			!p ||
			!tag ||
			old.clanMembers?.get(id) !== tag ||
			state.clanSides.get(tag) !== move.to ||
			p.faction === move.to ||
			!valid.has(p.faction ?? '')
		)
			state.moving.delete(id);
	}
	for (const [id] of state.openSince)
		if (!state.clanMembers.has(id) || old.clanMembers?.get(id) !== state.clanMembers.get(id))
			state.openSince.delete(id);
	for (const [id, asks] of state.asked)
		if (!asks.length) {
			state.asked.delete(id);
			state.capped.delete(id);
		}
	const waiting: Member[] = [];
	for (const [tag, group] of groups) {
		const target = state.clanSides.get(tag);
		for (const p of group) {
			if (!target || !valid.has(p.faction ?? '')) {
				state.openSince.delete(p.steamId);
				continue;
			}
			if (p.faction === target) {
				const since = state.openSince.get(p.steamId) ?? now;
				state.openSince.set(p.steamId, since);
				if (now - since >= TWO_TEAMS_SETTLED_MS) {
					state.asked.delete(p.steamId);
					state.capped.delete(p.steamId);
				}
				continue;
			}
			state.openSince.delete(p.steamId);
			if (sideOf(p) === target) continue;
			const asks = state.asked.get(p.steamId) ?? [];
			if (asks.length >= TWO_TEAMS_MAX_ASKS) {
				if (!state.capped.has(p.steamId)) {
					state.capped.add(p.steamId);
					result.stopped.push({ ...p, faction: p.faction! });
				}
				continue;
			}
			state.capped.delete(p.steamId);
			const last = asks.at(-1);
			const flight = state.moving.get(p.steamId);
			if (
				(last !== undefined && now - last < TWO_TEAMS_RETRY_MS) ||
				(flight && now - flight.at < TWO_TEAMS_RETRY_MS)
			)
				continue;
			waiting.push(p);
		}
	}
	// Fresh placements go before retries, then the longest-waiting retry, as in Two-team mode.
	waiting.sort(
		(a, b) =>
			(state.asked.get(a.steamId)?.at(-1) ?? -Infinity) -
			(state.asked.get(b.steamId)?.at(-1) ?? -Infinity)
	);
	for (const p of waiting.slice(0, Math.max(0, Math.floor(maxMoves)))) {
		const target = state.clanSides.get(state.clanMembers.get(p.steamId)!)!;
		result.moves.push({
			steamId: p.steamId,
			name: p.name,
			from: p.faction!,
			to: target,
			why: 'clan'
		});
		if (cfg.watchOnly) state.would.set(p.steamId, { from: p.faction!, to: target, seen: now });
		else {
			state.moving.set(p.steamId, { from: p.faction!, to: target, at: now, seq: look.seq ?? 0 });
			state.asked.set(p.steamId, [...(state.asked.get(p.steamId) ?? []), now]);
			if (!state.clanNotices.has(p.steamId))
				state.clanNotices.set(p.steamId, {
					tag: state.clanMembers.get(p.steamId)!,
					faction: target,
					leader: state.clanLeaders.get(state.clanMembers.get(p.steamId)!) ?? null
				});
		}
	}
	return result;
}
