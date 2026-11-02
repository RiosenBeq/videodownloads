import { describe, expect, it } from 'vitest';
import {
  createJobSchema,
  domainSchema,
  formatBytes,
  formatDuration,
  formatEta,
  formatSpeed,
  pickVariant,
  resolutionLabel,
  settingsPatchSchema,
  SpeedMeter,
} from '../src';

describe('formatters', () => {
  it('formats bytes, speeds and durations', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(250 * 1024 * 1024)).toBe('250 MB');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatSpeed(2 * 1024 * 1024)).toBe('2.0 MB/s');
    expect(formatDuration(75)).toBe('1:15');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatEta(42)).toBe('42s');
    expect(formatEta(130)).toBe('2m 10s');
    expect(formatEta(4000)).toBe('1h 6m');
  });

  it('labels resolutions', () => {
    expect(resolutionLabel(2160, 3840)).toBe('4K');
    expect(resolutionLabel(1088, 1920)).toBe('1080p');
    expect(resolutionLabel(1920, 1080)).toBe('1080p');
    expect(resolutionLabel(undefined)).toBe('');
  });
});

describe('pickVariant', () => {
  const variants = [
    { id: 'a', height: 360, width: 640, bandwidth: 800, container: 'mp4' },
    { id: 'b', height: 1080, width: 1920, bandwidth: 5000, container: 'mp4' },
    { id: 'c', height: 720, width: 1280, bandwidth: 2500, container: 'webm' },
    { id: 'd', height: 2160, width: 3840, bandwidth: 15000, container: 'webm' },
  ];

  it('picks highest, lowest and capped qualities', () => {
    expect(pickVariant(variants, 'highest')?.id).toBe('d');
    expect(pickVariant(variants, 'lowest')?.id).toBe('a');
    expect(pickVariant(variants, '1080')?.id).toBe('b');
    expect(pickVariant(variants, '480')?.id).toBe('a');
  });

  it('respects container preference when possible', () => {
    expect(pickVariant(variants, 'highest', 'mp4')?.id).toBe('b');
    expect(pickVariant(variants, '1080', 'webm')?.id).toBe('c');
  });

  it('falls back to the smallest when all exceed the cap', () => {
    expect(pickVariant([{ height: 720 }, { height: 1080 }], '360')?.height).toBe(720);
  });
});

describe('SpeedMeter', () => {
  it('computes speed and ETA over a window', () => {
    const meter = new SpeedMeter(5000);
    meter.push(0, 0);
    expect(meter.speed()).toBeUndefined();
    meter.push(1_000_000, 1000);
    meter.push(2_000_000, 2000);
    expect(meter.speed()).toBe(1_000_000);
    expect(meter.eta(10_000_000, 2_000_000)).toBe(8);
  });
});

describe('schemas', () => {
  it('validates job creation requests', () => {
    expect(createJobSchema.safeParse({ url: 'https://e.com/a.mp4', kind: 'direct' }).success).toBe(true);
    expect(createJobSchema.safeParse({ url: 'file:///etc/passwd', kind: 'direct' }).success).toBe(false);
    expect(createJobSchema.safeParse({ url: 'https://e.com/a.mp4', kind: 'shell' }).success).toBe(false);
    expect(createJobSchema.safeParse({ url: 'https://e.com/a.mp4', kind: 'direct', extra: 1 }).success).toBe(false);
    expect(createJobSchema.safeParse({ url: 'https://e.com', kind: 'page', formatId: '--exec rm' }).success).toBe(false);
    expect(createJobSchema.safeParse({ url: 'https://e.com', kind: 'page', formatId: 'bv*[height<=1080]+ba/b' }).success).toBe(true);
  });

  it('normalizes and validates domains', () => {
    expect(domainSchema.parse('*.Example.COM')).toBe('example.com');
    expect(domainSchema.safeParse('exa mple.com').success).toBe(false);
    expect(domainSchema.safeParse('http://x.com').success).toBe(false);
    expect(settingsPatchSchema.safeParse({ maxConcurrent: 99 }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ unknown: true }).success).toBe(false);
  });
});
