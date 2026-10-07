import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_BAN_REASON_PRESETS,
	MAX_BAN_REASON_LENGTH,
	MAX_BAN_REASON_PRESETS,
	banReasonPresetsProblem,
	normalizeBanReasonPresets
} from './ban-reasons';

describe('Ban reason presets', () => {
	test('the initial reasons and a deliberately empty list are valid', () => {
		expect(banReasonPresetsProblem(DEFAULT_BAN_REASON_PRESETS)).toBe('');
		expect(banReasonPresetsProblem([])).toBe('');
	});
	test('normalizes whitespace while keeping order, language and literal placeholders', () => {
		expect(
			normalizeBanReasonPresets(['  Team\n killing  ', 'Règles нарушены', '{reason}'])
		).toEqual(['Team killing', 'Règles нарушены', '{reason}']);
	});
	test('rejects invalid shapes, empty rows, controls, duplicate spellings and excessive sizes', () => {
		for (const value of [
			null,
			'Cheating',
			{},
			[12],
			[''],
			['  '],
			['Cheating', ' CHEATING '],
			['ＡＢＣ', 'abc'],
			['bad\u0000reason'],
			['x'.repeat(MAX_BAN_REASON_LENGTH + 1)],
			Array.from({ length: MAX_BAN_REASON_PRESETS + 1 }, (_, i) => `Reason ${i}`)
		])
			expect(banReasonPresetsProblem(value)).not.toBe('');
	});
	test('accepts the exact count and length boundaries', () => {
		expect(banReasonPresetsProblem(['x'.repeat(MAX_BAN_REASON_LENGTH)])).toBe('');
		expect(
			banReasonPresetsProblem(
				Array.from({ length: MAX_BAN_REASON_PRESETS }, (_, i) => `Reason ${i}`)
			)
		).toBe('');
	});
});
