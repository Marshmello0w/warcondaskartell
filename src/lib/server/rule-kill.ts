// A kill a rule sends for what a player did, with a whisper telling them why: the game kills the
// player, then the rule's text is whispered to them. Any rule that kills a player for what they did
// uses this action, so what it needs of whoever saves the rule is what the two need by hand: Kill
// and Chat. outbox.ts delivers the row through killAndTell.
import type { Capability } from '$lib/capabilities';
import { MAX_CHAT } from '$lib/chat';
import { ACTIONS } from './actions';
import { forLog, str } from './http';
import { GameError, type WardogsClient } from './rcon';

/** The outbox action of a rule's kill and its whisper. Not in ACTIONS, so no route can run it. */
export const RULE_KILL = 'rule_kill';

export interface RuleKillParams {
	steamId: string;
	/** the player's name, for the outcome */
	name: string;
	/** what they did, in the panel's words, for the outcome */
	why: string;
	/** what they are whispered */
	message: string;
}

/** What a rule that kills and tells needs of whoever saves it: Kill, then Chat. */
export const RULE_KILL_NEEDS: [[Capability, string], [Capability, string]] = [
	['players.kill', 'kills players'],
	['chat.send', 'whispers players']
];

/**
 * A rule's kill goes within this long of being decided, or not at all: one sent later lands on a
 * player doing something else by then, or, past a map change, on the next map.
 */
export const RULE_KILL_MAX_AGE_MS = 30_000;

/**
 * Kills the player, then whispers them the rule's text. A kill the game refuses for any reason but
 * the panel sending too fast or the server failing (no living character, presumably: dead already,
 * or not spawned; its answer has not been seen) still sends the whisper; "no such player" among
 * them, since the player list has just shown them on. When the whisper is refused too, nothing was
 * done and the row fails: as the whisper's refusal when the game asked the panel to slow down (so
 * the server is held), else as the kill's. After a kill, a whisper that is not sent leaves the kill
 * as done; one refused for sending too fast carries the wait the game asked for (`retryAfterMs`),
 * so the caller holds the server. The outcome is in fixed words, never the game's.
 */
export async function killAndTell(
	client: WardogsClient,
	params: Record<string, unknown>
): Promise<{ message: string; retryAfterMs?: number }> {
	const steamId = str(params.steamId, 32);
	const who = str(params.name, 100) || steamId;
	const why = str(params.why, 200);
	let refused: GameError | null = null;
	try {
		await ACTIONS.kill.run(client, { steamId });
	} catch (err) {
		if (
			!(err instanceof GameError) ||
			err.code === 'rate_limited' ||
			err.code === 'unreachable' ||
			err.status === 401 ||
			err.status === 403 ||
			err.status >= 500
		)
			throw err;
		refused = err;
	}
	const message = str(params.message, MAX_CHAT);
	if (refused && !message) throw refused;
	let told = false;
	let retryAfterMs = 0;
	if (message)
		try {
			await ACTIONS.whisper.run(client, { steamId, message });
			told = true;
		} catch (err) {
			const slow = err instanceof GameError && err.code === 'rate_limited';
			if (refused) throw slow ? err : refused;
			if (slow) retryAfterMs = err.retryAfterMs || 5000;
			else if (!(err instanceof GameError))
				console.warn('[warcon] a rule kill’s whisper was not sent:', forLog(err));
		}
	return {
		message: refused
			? `Told ${who}, but the game refused the kill: ${why}`
			: `Killed ${who}: ${why}${told ? '' : retryAfterMs ? ' (not told: the server asked the panel to slow down)' : ' (not told)'}`,
		...(retryAfterMs ? { retryAfterMs } : {})
	};
}
