/** Initial suggestions for each organisation; an empty saved list deliberately offers none. */
export const DEFAULT_BAN_REASON_PRESETS = [
	'Cheating',
	'Team killing',
	'Toxic behaviour',
	'Racism / hate speech',
	'Ban evasion',
	'Griefing'
];

export const MAX_BAN_REASON_PRESETS = 30;
export const MAX_BAN_REASON_LENGTH = 200;

export const normalizeBanReasonPresets = (reasons: readonly string[]): string[] =>
	reasons.map((reason) => reason.replace(/\s+/g, ' ').trim());

/** Shared form/API validation: refuse invalid entries rather than silently shortening reasons. */
export function banReasonPresetsProblem(value: unknown): string {
	if (!Array.isArray(value) || value.some((reason) => typeof reason !== 'string'))
		return 'Ban reason presets must be a list of text reasons.';
	if (value.length > MAX_BAN_REASON_PRESETS)
		return `At most ${MAX_BAN_REASON_PRESETS} preset reasons can be saved.`;
	const seen = new Set<string>();
	for (const reason of normalizeBanReasonPresets(value)) {
		if (!reason) return 'Each preset reason must contain text. Remove empty rows to save.';
		if (reason.length > MAX_BAN_REASON_LENGTH)
			return `Each preset reason must be ${MAX_BAN_REASON_LENGTH} characters or fewer.`;
		if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason))
			return 'Preset reasons cannot contain control characters.';
		const folded = reason.normalize('NFKC').toLowerCase();
		if (seen.has(folded)) return 'Each preset reason must be unique (ignoring letter case).';
		seen.add(folded);
	}
	return '';
}
