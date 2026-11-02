/**
 * Which URLs the helper may fetch. Combines scheme/credential checks, the
 * user's domain allow/block lists and SSRF protection. The `lookup` function
 * validates every address a hostname resolves to at connection time, so DNS
 * rebinding between check and use is not possible.
 */
import dns from 'node:dns';
import net from 'node:net';
import { matchesAnyDomain, safeParseUrl, type BackendSettings } from '@clipkeeper/shared';
import { AppError } from '../errors';
import { isPublicAddress } from './ip';

export type PolicyOptions = Pick<BackendSettings, 'allowedDomains' | 'blockedDomains' | 'allowPrivateNetwork'>;

type LookupAddress = { address: string; family: number };
type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home.arpa', 'intranet'];

export class UrlPolicy {
  constructor(private readonly options: PolicyOptions) {}

  get allowPrivateNetwork(): boolean {
    return this.options.allowPrivateNetwork;
  }

  /** Synchronous validation. Throws AppError('URL_NOT_ALLOWED') when rejected. */
  assertUrl(input: string): URL {
    const url = safeParseUrl(input);
    if (!url) throw new AppError('BAD_REQUEST', 'Invalid URL.');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError('URL_NOT_ALLOWED', 'Only http and https URLs can be downloaded.');
    }
    if (url.username || url.password) {
      throw new AppError('URL_NOT_ALLOWED', 'URLs with embedded credentials are not allowed.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!host) throw new AppError('BAD_REQUEST', 'URL has no host.');

    if (matchesAnyDomain(host, this.options.blockedDomains)) {
      throw new AppError('URL_NOT_ALLOWED', `Downloads from ${host} are blocked in the helper settings.`);
    }
    if (this.options.allowedDomains.length && !matchesAnyDomain(host, this.options.allowedDomains)) {
      throw new AppError('URL_NOT_ALLOWED', `${host} is not in the helper's list of allowed download domains.`);
    }
    if (net.isIP(host)) {
      this.assertAddress(host);
    } else if (!this.options.allowPrivateNetwork && LOCAL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
      throw new AppError('URL_NOT_ALLOWED', `${host} is a local network name; local sources are disabled.`);
    }
    return url;
  }

  assertAddress(address: string): void {
    if (!this.options.allowPrivateNetwork && !isPublicAddress(address)) {
      throw new AppError(
        'URL_NOT_ALLOWED',
        'The source resolves to a private or reserved network address. Enable "Allow local network sources" in settings if this is intended.',
      );
    }
  }

  /** Drop-in replacement for dns.lookup used by http(s).request. */
  readonly lookup = (hostname: string, options: dns.LookupOptions | number | LookupCallback, callback?: LookupCallback): void => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
    const opts: dns.LookupOptions = typeof options === 'object' && options ? options : {};
    dns.lookup(hostname, { family: opts.family ?? 0, hints: opts.hints, all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err, '', 0);
      const list = addresses as LookupAddress[];
      try {
        if (!list.length) throw new AppError('NETWORK', `No addresses found for ${hostname}`);
        for (const a of list) this.assertAddress(a.address);
      } catch (error) {
        return cb(error as NodeJS.ErrnoException, '', 0);
      }
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}
