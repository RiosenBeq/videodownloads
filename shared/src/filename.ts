/**
 * Cross-platform file name handling. Names produced here are safe on macOS,
 * Windows and Linux: no separators, no control characters, no reserved device
 * names, no trailing dots/spaces, bounded length.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const DEFAULT_MAX_LENGTH = 150;
const MEDIA_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ts', 'ogg', 'ogv', '3gp', 'm3u8', 'mpd']);

export interface SanitizeOptions {
  maxLength?: number;
  fallback?: string;
}

/** Truncate without splitting a UTF-16 surrogate pair. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  let cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

export function sanitizeFilename(input: string, options: SanitizeOptions = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const fallback = options.fallback ?? 'video';

  let name = String(input ?? '').normalize('NFC');
  name = name
    // control characters, including DEL and C1 controls
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    // bidi overrides / zero-width characters that can disguise extensions
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/:/g, ' -')
    .replace(/[\\/|]/g, '-')
    .replace(/[<>"?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Dots/spaces at either end are invalid on Windows and hide files on Unix.
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  name = truncate(name, maxLength).replace(/[.\s]+$/, '');

  if (!name) name = fallback;
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  return name;
}

export function sanitizeExtension(ext: string | undefined): string {
  const clean = (ext ?? '').replace(/^\./, '').toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(clean) ? clean : '';
}

export function splitExtension(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { base: name, ext: '' };
  const ext = name.slice(dot + 1);
  if (!/^[a-z0-9]{1,5}$/i.test(ext)) return { base: name, ext: '' };
  return { base: name.slice(0, dot), ext: ext.toLowerCase() };
}

/** Sanitize a full file name and force the given extension. */
export function finalizeFilename(name: string, ext: string, options: SanitizeOptions = {}): string {
  const extension = sanitizeExtension(ext) || 'mp4';
  const { base, ext: existing } = splitExtension(String(name ?? ''));
  const stem = existing === extension || MEDIA_EXTENSIONS.has(existing) ? base : String(name ?? '');
  const max = (options.maxLength ?? DEFAULT_MAX_LENGTH) - extension.length - 1;
  return `${sanitizeFilename(stem, { ...options, maxLength: Math.max(1, max) })}.${extension}`;
}

export interface FilenameVars {
  title: string;
  site?: string;
  resolution?: string;
  id?: string;
  date?: Date;
}

/**
 * Expand a template such as "{title} ({resolution})" or "{site} - {title}".
 * Supported tokens: {title} {site} {resolution} {date} {id}. Empty optional
 * tokens collapse together with surrounding brackets.
 */
export function applyFilenameTemplate(template: string, vars: FilenameVars): string {
  const date = vars.date ?? new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const values: Record<string, string> = {
    title: vars.title ?? '',
    site: vars.site ?? '',
    resolution: vars.resolution ?? '',
    id: vars.id ?? '',
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
  };
  const expanded = (template || '{title}')
    .replace(/\{(title|site|resolution|date|id)\}/g, (_m, key: string) => values[key])
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/\s+-\s*$|^\s*-\s+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return expanded || values.title || 'video';
}

export function buildFilename(template: string, vars: FilenameVars, ext: string): string {
  return finalizeFilename(applyFilenameTemplate(template, vars), ext);
}
