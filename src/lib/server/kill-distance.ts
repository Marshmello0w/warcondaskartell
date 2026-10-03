// The Kill distance rule's pure part: which kills it counts (one of the chosen weapons, from at
// least a distance), how many of them in one match catch a player, and what it keeps per player. A
// defibrillator or a fist reaches a few metres; the same kill from across the map is a player the
// game did not stop. From 0 m it counts every kill with the weapons, so a server can act on each
// kill with a weapon or a vehicle it does not allow. Kills are counted per match, as the Team kill
// limit counts them, rather than within minutes: the feed gives no kill a time the panel can trust
// across batches (a batch the game sends again arrives late, with only the match clock), and a
// match is what the game itself numbers. No database, no game server; the live path
// (feed-events.ts) and the dry run (triggers.ts) run the same step.
import { ApiError, int, str } from './http';
import { causeTags } from './cause-tags';
import { settingsFingerprint } from './fingerprint';
import { causeLabel } from '$lib/causes';
import type { BanScope } from './rule-ban';

/** The outbox action of a Kill distance flag: a panel action, nothing is sent to the game. */
export const KILL_DISTANCE_FLAG = 'kill_distance_flag';

export type KillDistanceAction = 'flag' | 'warn' | 'kick' | 'ban';

export interface KillDistanceConfig {
	/**
	 * the weapons, their own or a vehicle's, or the vehicles, as the kill feed tags them
	 * (`Id.Item.Defibrillator.Standard`); matched in any case
	 */
	causes: string[];
	/** a kill counts from this far, in metres; from 0 every kill does, one without a distance too */
	minDistanceM: number;
	/** this many counted kills in one match catch a player */
	count: number;
	action: KillDistanceAction;
	/** how long a ban lasts; 0 is for good */
	banDays: number;
	banScope: BanScope;
	/** what the player is told: the warning whispered, or the kick or ban reason */
	reason: string;
	/** a flagged or warned player is not flagged or warned again by the rule for this long */
	cooldownMinutes: number;
}

/**
 * The action a rule's settings ask for; anything else is a flag. Validation and the capability
 * check both read it here, so a dry run of settings that were never saved is checked for what
 * they would do.
 */
export const killDistanceAction = (c: unknown): KillDistanceAction => {
	const a = c && typeof c === 'object' ? (c as Record<string, unknown>).action : undefined;
	return a === 'warn' || a === 'kick' || a === 'ban' ? a : 'flag';
};
/** Which list a rule's ban goes on: the organisation's only when asked for by name. */
export const killDistanceBanScope = (c: unknown): BanScope =>
	c && typeof c === 'object' && (c as Record<string, unknown>).banScope === 'org'
		? 'org'
		: 'server';

export function validateKillDistance(c: Record<string, unknown>): KillDistanceConfig {
	const causes = causeTags(c.causes, 'weapon', 'Id.Item.Defibrillator.Standard');
	if (!causes.length) throw new ApiError(400, 'Pick at least one weapon.');
	const action = killDistanceAction(c);
	return {
		causes,
		minDistanceM: int(c.minDistanceM, 100, 0, 20_000),
		count: int(c.count, 2, 1, 100),
		action,
		banDays: int(c.banDays, 0, 0, 3650),
		banScope: killDistanceBanScope(c),
		// a text left blank: a warning says what is not allowed, a kick or ban why
		reason:
			str(c.reason, 200) ||
			(action === 'warn'
				? '{weapon} is not allowed on this server.'
				: 'Impossible kill: {weapon} from {distance} m.'),
		cooldownMinutes: int(c.cooldownMinutes, 30, 1, 24 * 60)
	};
}

/**
 * What a rule's counts were made under. The counts start over when it changes: a kill counted
 * under looser settings is no evidence under the new ones.
 */
export const killDistanceSettingsKey = (cfg: KillDistanceConfig): string =>
	settingsFingerprint(cfg);

// The weapons of one settings object, in lower case; a rule's settings object lives as long as the
// worker's cache of enabled rules holds its row.
const causeSets = new WeakMap<KillDistanceConfig, Set<string>>();
function causeSet(cfg: KillDistanceConfig): Set<string> {
	let set = causeSets.get(cfg);
	if (!set) causeSets.set(cfg, (set = new Set(cfg.causes.map((c) => c.toLowerCase()))));
	return set;
}

/**
 * A kill the rule counts: a player's, not a suicide, with one of its weapons, from at least its
 * distance. From 0 m a kill the feed sends without a distance counts too: a vehicle blown up with
 * its crew inside, a roadkill.
 */
export function countsForDistance(
	cfg: KillDistanceConfig,
	k: {
		killer: string | null | undefined;
		suicide: boolean;
		cause: string | null;
		distanceM: number | null;
	}
): boolean {
	return (
		!!k.killer &&
		!k.suicide &&
		(cfg.minDistanceM <= 0 ||
			(typeof k.distanceM === 'number' && k.distanceM >= cfg.minDistanceM)) &&
		!!k.cause &&
		causeSet(cfg).has(k.cause.toLowerCase())
	);
}

/**
 * Which match a kill is counted in: the match it was stamped with on arrival (feed.ts), or, for a
 * kill that came in while no match was open, the hour it came in.
 */
export const matchKey = (matchRow: number | null, receivedMs: number): string =>
	matchRow !== null ? `m${matchRow}` : `h${Math.floor(receivedMs / 3600_000)}`;

/** One player's counted kills in the match so far, and when the rule last acted on them (ms). */
export interface DistanceTrack {
	count: number;
	actedAt: number | null;
}
export type DistanceTracks = Map<string, DistanceTrack>;

/**
 * How long a kick or a ban leaves the player alone: the time a kick takes to land (a second one
 * right behind it would find them gone). One who is back and does it again after that is acted on
 * at their next such kill.
 */
export const ACT_AGAIN_MS = 60_000;

const holdMs = (cfg: KillDistanceConfig): number =>
	cfg.action === 'flag' || cfg.action === 'warn' ? cfg.cooldownMinutes * 60_000 : ACT_AGAIN_MS;

/**
 * Counts one more kill of the player's in the match, taken in at `now` (ms, the panel's clock),
 * and returns the count when that catches them now, else null. The hold runs on the panel's clock,
 * not the kills': the rest of a burst, or of a batch the game held back, asks for nothing more
 * while the first action lands.
 */
export function killDistanceStep(
	cfg: KillDistanceConfig,
	tracks: DistanceTracks,
	steamId: string,
	now: number
): number | null {
	let t = tracks.get(steamId);
	if (!t) {
		t = { count: 0, actedAt: null };
		tracks.set(steamId, t);
	}
	t.count++;
	if (t.count < cfg.count) return null;
	if (t.actedAt !== null && now - t.actedAt < holdMs(cfg)) return null;
	t.actedAt = now;
	return t.count;
}

/**
 * What caught the player, in words: the kill, from how far when the feed said, and how many this
 * match when more than one was asked for.
 */
export function killDistanceVerdict(
	cfg: KillDistanceConfig,
	cause: string | null,
	distanceM: number | null,
	count: number
): string {
	const what =
		distanceM === null
			? `${causeLabel(cause)} kill`
			: `${causeLabel(cause)} kill from ${Math.round(distanceM)} m`;
	return cfg.count > 1 ? `${what} (${count} this match)` : what;
}

export interface DistanceKill {
	/** when the panel took it in (ms) */
	at: number;
	/** matchKey of the kill */
	match: string;
	steamId: string;
	name: string;
	cause: string | null;
	distanceM: number | null;
}

/**
 * The kills that would have caught a player, over `kills` (counted kills, in the order they came
 * in), with the match's count at each.
 */
export function killDistanceReplay(
	cfg: KillDistanceConfig,
	kills: DistanceKill[]
): (DistanceKill & { count: number })[] {
	const matches = new Map<string, DistanceTracks>();
	const out: (DistanceKill & { count: number })[] = [];
	for (const k of kills) {
		let tracks = matches.get(k.match);
		if (!tracks) matches.set(k.match, (tracks = new Map()));
		const count = killDistanceStep(cfg, tracks, k.steamId, k.at);
		if (count !== null) out.push({ ...k, count });
	}
	return out;
}
