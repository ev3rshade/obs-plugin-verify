import { describe, it, expect } from 'vitest';
import { toCallout, isCalloutType } from '../src/callout';

describe('toCallout', () => {
	it('wraps a single line', () => {
		expect(toCallout('hello', 'note')).toBe('> [!note]\n> hello');
	});

	it('adds a trimmed title', () => {
		expect(toCallout('x', 'tip', '  Heads up ')).toBe('> [!tip] Heads up\n> x');
	});

	it('keeps blank lines inside the callout', () => {
		expect(toCallout('a\n\nb', 'info')).toBe('> [!info]\n> a\n>\n> b');
	});

	it('normalizes CRLF and drops trailing newlines', () => {
		expect(toCallout('a\r\nb\n\n', 'note')).toBe('> [!note]\n> a\n> b');
	});

	it('returns only the header for empty input', () => {
		expect(toCallout('', 'warning')).toBe('> [!warning]');
	});
});

describe('isCalloutType', () => {
	it('accepts known and rejects unknown types', () => {
		expect(isCalloutType('danger')).toBe(true);
		expect(isCalloutType('banana')).toBe(false);
	});
});
