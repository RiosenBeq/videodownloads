import type { BackendSettings, ContainerFormat } from './types';

export const APP_NAME = 'Clipkeeper';
export const APP_VERSION = '1.0.0';
export const API_VERSION = 1;

export const DEFAULT_BACKEND_PORT = 47321;
export const DEFAULT_BACKEND_URL = `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;

/** File extensions treated as complete, directly downloadable video files. */
export const DIRECT_VIDEO_EXTENSIONS: Record<string, ContainerFormat> = {
  mp4: 'mp4',
  m4v: 'm4v',
  webm: 'webm',
  mov: 'mov',
  mkv: 'mkv',
  ogv: 'ogg',
  ogg: 'ogg',
  '3gp': '3gp',
};

export const DIRECT_VIDEO_MIME: Record<string, ContainerFormat> = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogg',
  'video/3gpp': '3gp',
};

export const HLS_MIME_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/mpegurl',
];

export const DASH_MIME_TYPES = ['application/dash+xml'];

/** Extensions of stream fragments; these are never listed as standalone videos. */
export const SEGMENT_EXTENSIONS = ['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'mp4a', 'aac', 'vtt', 'webvtt', 'key'];

export const SEGMENT_MIME_TYPES = ['video/mp2t', 'video/iso.segment', 'audio/iso.segment'];

export const DEFAULT_BACKEND_SETTINGS: Omit<BackendSettings, 'downloadDir'> = {
  maxConcurrent: 2,
  segmentConcurrency: 4,
  maxRetries: 3,
  allowedDomains: [],
  blockedDomains: [],
  allowPrivateNetwork: false,
  ytDlpEnabled: false,
  ytDlpDomains: [],
  allowedExtensionIds: [],
};

export const DEFAULT_FILENAME_TEMPLATE = '{title}';
