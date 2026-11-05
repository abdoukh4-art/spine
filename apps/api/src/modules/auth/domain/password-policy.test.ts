import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkPasswordPolicy,
  codePointLength,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './password-policy.js';

const codes = (password: string, email?: string) =>
  checkPasswordPolicy(password, email === undefined ? {} : { email }).map((v) => v.code);

describe('password policy', () => {
  it('accepts a long passphrase without composition rules', () => {
    expect(codes('correct horse battery staple')).toEqual([]);
  });

  it('rejects passwords shorter than 12 characters', () => {
    expect(codes('short-pass1')).toEqual(['too_short']);
  });

  it('rejects passwords longer than 128 characters', () => {
    expect(codes('x'.repeat(129))).toEqual(['too_long']);
  });

  it('counts code points, so an emoji is one character', () => {
    expect(codePointLength('🔒🔒')).toBe(2);
    expect(codes('🔒'.repeat(11))).toEqual(['too_short']);
    expect(codes('🔒'.repeat(12))).toEqual([]);
  });

  it('rejects well-known passwords case-insensitively', () => {
    expect(codes('Password1234')).toEqual(['common']);
  });

  it('rejects passwords containing the email local part', () => {
    expect(codes('my-alice-password-x', 'Alice@corp.test')).toEqual(['contains_email']);
    // Local parts under 3 characters are too short to be meaningful.
    expect(codes('abcdefghijklmnop', 'ab@corp.test')).toEqual([]);
  });

  it('property: any string of 12..128 code points from a safe alphabet is accepted', () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(...'abcdefghijkmnopqrstuvwxyz0123456789-_ '.split('')),
          minLength: PASSWORD_MIN_LENGTH,
          maxLength: PASSWORD_MAX_LENGTH,
        }),
        (pw) => {
          const result = codes(pw);
          // Only the deny-list could still match; the length rules never fire in range.
          expect(result.filter((c) => c === 'too_short' || c === 'too_long')).toEqual([]);
        },
      ),
    );
  });

  it('property: the length verdict depends only on the code-point count', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 200 }), (pw) => {
        const length = codePointLength(pw);
        const result = codes(pw);
        expect(result.includes('too_short')).toBe(length < PASSWORD_MIN_LENGTH);
        expect(result.includes('too_long')).toBe(length > PASSWORD_MAX_LENGTH);
      }),
    );
  });
});
