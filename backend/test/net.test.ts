import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { embeddedIpv4, expandIpv6, isPublicAddress } from '../src/net/ip';
import { UrlPolicy } from '../src/net/policy';
import { parseContentRange, responseTotalSize } from '../src/net/safeRequest';

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '127.8.9.10',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '2002:c0a8:0101::1',
    '2001:db8::1',
    'not-an-ip',
  ])('rejects %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8'])(
    'accepts %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it('expands IPv6 and extracts embedded IPv4', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6('2001:db8::8a2e:370:7334')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334]);
    expect(expandIpv6('1::2::3')).toBeNull();
    expect(embeddedIpv4('::ffff:192.168.0.1')).toBe('192.168.0.1');
    expect(embeddedIpv4('64:ff9b::0808:0808')).toBe('8.8.8.8');
  });
});

describe('UrlPolicy', () => {
  const strict = new UrlPolicy({ allowedDomains: [], blockedDomains: ['ads.example.com'], allowPrivateNetwork: false });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return (error as AppError).code;
    }
    return 'OK';
  };

  it('accepts public http(s) URLs', () => {
    expect(code(() => strict.assertUrl('https://cdn.example.com/video.mp4'))).toBe('OK');
    expect(code(() => strict.assertUrl('http://8.8.8.8/a.mp4'))).toBe('OK');
  });

  it('rejects other schemes, credentials and blocked or local hosts', () => {
    expect(code(() => strict.assertUrl('file:///etc/passwd'))).toBe('URL_NOT_ALLOWED');
    expect(code(() => strict.assertUrl('ftp://example.com/a.mp4'))).toBe('URL_NOT_ALLOWED');
    expect(code(() => strict.assertUrl('https://user:pass@example.com/a.mp4'))).toBe('URL_NOT_ALLOWED');
    expect(code(() => strict.assertUrl('https://x.ads.example.com/a.mp4'))).toBe('URL_NOT_ALLOWED');
    expect(code(() => strict.assertUrl('http://127.0.0.1:8080/a.mp4'))).toBe('URL_NOT_ALLOWED');
    expect(code(() => strict.assertUrl('http://[::1]/a.mp4'))).toBe('URL_NOT_ALLOWED');
    expect(code(() => strict.assertUrl('http://[::ffff:169.254.169.254]/'))).toBe('URL_NOT_ALLOWED');
    expect(code(() => strict.assertUrl('http://localhost/a.mp4'))).toBe('URL_NOT_ALLOWED');
    expect(code(() => strict.assertUrl('http://nas.local/a.mp4'))).toBe('URL_NOT_ALLOWED');
    expect(code(() => strict.assertUrl('not a url'))).toBe('BAD_REQUEST');
  });

  it('enforces an allow-list when present', () => {
    const allow = new UrlPolicy({ allowedDomains: ['example.com'], blockedDomains: [], allowPrivateNetwork: false });
    expect(code(() => allow.assertUrl('https://media.example.com/a.mp4'))).toBe('OK');
    expect(code(() => allow.assertUrl('https://example.org/a.mp4'))).toBe('URL_NOT_ALLOWED');
  });

  it('validates resolved addresses at connection time (DNS rebinding)', async () => {
    const lookup = (host: string) =>
      new Promise<unknown>((resolve) => strict.lookup(host, { all: true }, (err, addresses) => resolve(err ? (err as AppError).code : addresses)));
    expect(await lookup('localhost')).toBe('URL_NOT_ALLOWED');
    const relaxed = new UrlPolicy({ allowedDomains: [], blockedDomains: [], allowPrivateNetwork: true });
    const ok = await new Promise<unknown>((resolve) => relaxed.lookup('localhost', {}, (err, address) => resolve(err ?? address)));
    expect(typeof ok).toBe('string');
  });
});

describe('response helpers', () => {
  it('parses Content-Range and total sizes', () => {
    expect(parseContentRange('bytes 100-199/1000')).toEqual({ start: 100, end: 199, total: 1000 });
    expect(parseContentRange('bytes 0-9/*')).toEqual({ start: 0, end: 9, total: undefined });
    expect(parseContentRange('garbage')).toBeNull();
    expect(responseTotalSize({ statusCode: 206, headers: { 'content-range': 'bytes 5-9/50' } })).toBe(50);
    expect(responseTotalSize({ statusCode: 200, headers: { 'content-length': '42' } })).toBe(42);
  });
});
