/** Human-readable formatting helpers used by the UI and logs. */

export function formatBytes(bytes: number | undefined | null, digits = 1): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const fixed = value >= 100 ? value.toFixed(0) : value.toFixed(digits);
  return `${fixed} ${units[unit]}`;
}

export function formatSpeed(bytesPerSecond: number | undefined | null): string {
  if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** 75 → "1:15", 3725 → "1:02:05". */
export function formatDuration(seconds: number | undefined | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Remaining time: 42 → "42s", 130 → "2m 10s", 4000 → "1h 6m". */
export function formatEta(seconds: number | undefined | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  return s ? `${m}m ${s}s` : `${m}m`;
}

/** Short quality label: 2160 → "4K", 1080 → "1080p". Uses the short side for portrait video. */
export function resolutionLabel(height?: number, width?: number): string {
  if (!height) return '';
  const side = width && width < height ? width : height;
  if (side >= 4320) return '8K';
  if (side >= 2160) return '4K';
  if (side >= 1440) return '1440p';
  // Snap common encoder heights (e.g. 1088, 718) to the familiar label.
  const standard = [1080, 720, 576, 480, 360, 240, 144];
  const snapped = standard.find((s) => Math.abs(side - s) <= 12);
  return `${snapped ?? side}p`;
}

export function formatBitrate(bitsPerSecond?: number): string {
  if (!bitsPerSecond || !Number.isFinite(bitsPerSecond)) return '';
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
