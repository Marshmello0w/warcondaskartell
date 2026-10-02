import { afterEach, describe, expect, test } from 'bun:test';
import { forgetMemory, memoryFor, OFFLINE_AFTER_FAILURES, planNext, replan } from './observe';

const memory = () => memoryFor({ id: 'two-team-cadence' } as never, {} as never);
afterEach(() => forgetMemory('two-team-cadence'));

describe('Two-team roster cadence', () => {
	test('keeps reading an idle server every 15 seconds without changing its status cadence', () => {
		const m = memory();
		m.twoTeamsOn = true;
		planNext(m, 1000, { players: true, status: true });
		expect(m.playersIntervalMs).toBe(15_000);
		expect(m.playersDueAt).toBe(16_000);
		expect(m.statusDueAt).toBe(31_000);
	});

	test('turning the rule on pulls in the next roster, and switching it off restores the cadence', () => {
		const m = memory();
		planNext(m, 1000, { players: true, status: true });
		expect(m.playersIntervalMs).toBe(30_000);
		m.twoTeamsOn = true;
		replan(m, 1000);
		expect(m.playersDueAt).toBe(16_000);
		m.twoTeamsOn = false;
		planNext(m, 16_000, { players: true, status: false });
		expect(m.playersIntervalMs).toBe(30_000);
	});

	test('respects rate-limit holds and offline backoff', () => {
		const m = memory();
		m.twoTeamsOn = true;
		m.holdUntil = 90_000;
		planNext(m, 1000, { players: true, status: true });
		expect(m.playersDueAt).toBe(90_000);
		m.holdUntil = 0;
		m.failures = OFFLINE_AFTER_FAILURES;
		planNext(m, 100_000, { players: true, status: true });
		expect(m.playersIntervalMs).toBe(30_000);
	});
});
