import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalIp, formatIpv6, isIpv4, parseIpv6 } from './ip.js';

describe('IP helpers', () => {
  it.each([
    ['192.0.2.1', true],
    ['255.255.255.255', true],
    ['0.0.0.0', true],
    ['256.0.0.1', false],
    ['010.0.0.1', false],
    ['1.2.3', false],
    ['1.2.3.4.5', false],
  ])('isIpv4(%s) = %s', (input, expected) => {
    expect(isIpv4(input)).toBe(expected);
  });

  it.each([
    ['2001:DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['2001:0db8:0000:0000:0000:0000:0000:0042', '2001:db8::42'],
    ['::', '::'],
    ['::1', '::1'],
    ['1::', '1::'],
    ['2001:db8:0:1:0:0:0:1', '2001:db8:0:1::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2:3:4:5:6'],
    ['2001:db8:0:2:3:4:5:6', '2001:db8:0:2:3:4:5:6'],
    ['::ffff:192.0.2.1', '::ffff:c000:201'],
    ['[2001:db8::1]', '2001:db8::1'],
  ])('canonicalIp(%s) = %s (RFC 5952)', (input, expected) => {
    expect(canonicalIp(input)).toEqual({ family: 'ipv6', value: expected });
  });

  it.each([
    '2001:db8::1::1',
    '2001:db8:::1',
    '12345::1',
    'fe80::1%eth0',
    'g::1',
    '1:2:3:4:5:6:7:8:9',
    '::ffff:999.0.0.1',
    ':',
    '1:2:3:4:5:6:7',
  ])('rejects %s', (input) => {
    expect(canonicalIp(input)).toBeNull();
  });

  it('round-trips any 8 hextets through format → parse', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 8, maxLength: 8 }),
        (h) => {
          expect(parseIpv6(formatIpv6(h))).toEqual(h);
        },
      ),
    );
  });

  it('canonicalIp is idempotent and never throws', () => {
    fc.assert(
      fc.property(fc.oneof(fc.ipV6(), fc.ipV4(), fc.string()), (s) => {
        const once = canonicalIp(s);
        if (once) expect(canonicalIp(once.value)).toEqual(once);
      }),
    );
  });
});
