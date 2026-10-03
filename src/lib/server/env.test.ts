import { describe, expect, test } from 'bun:test';
import { supportUrl } from './env';

describe('supportUrl', () => {
	test('an https URL is linked', () => {
		expect(supportUrl({ SUPPORT_URL: 'https://github.com/sponsors/example' })).toBe(
			'https://github.com/sponsors/example'
		);
		expect(supportUrl({ SUPPORT_URL: '  https://github.com/sponsors/example  ' })).toBe(
			'https://github.com/sponsors/example'
		);
	});

	test('unset or blank shows no link', () => {
		expect(supportUrl({})).toBeNull();
		expect(supportUrl({ SUPPORT_URL: '' })).toBeNull();
		expect(supportUrl({ SUPPORT_URL: '   ' })).toBeNull();
	});

	test('anything but https shows no link', () => {
		for (const value of [
			'http://github.com/sponsors/example',
			'javascript:alert(1)',
			'JavaScript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'//github.com/sponsors/example',
			'github.com/sponsors/example',
			'not a url'
		]) {
			expect(supportUrl({ SUPPORT_URL: value })).toBeNull();
		}
	});
});
