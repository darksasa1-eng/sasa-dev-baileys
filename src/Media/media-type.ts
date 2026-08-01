/** WhatsApp media categories used for HKDF key derivation + uploads */
export type MediaType =
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'sticker'
  | 'history'
  | 'link-preview'
  | 'product-catalog-image'
  | 'md-app-state'
  | 'product'
  | 'ptt'
  | 'thumbnail-link'
  | 'md-msg-hist';

/** HKDF info strings per media class (part of the encryption spec) */
const MEDIA_HKDF_INFO: Record<MediaType, string> = {
  image: 'WhatsApp Image Keys',
  video: 'WhatsApp Video Keys',
  audio: 'WhatsApp Audio Keys',
  document: 'WhatsApp Document Keys',
  sticker: 'WhatsApp Image Keys',
  history: 'WhatsApp History Keys',
  'md-msg-hist': 'WhatsApp History Keys',
  'link-preview': 'WhatsApp Link Preview Keys',
  'product-catalog-image': 'WhatsApp Product Catalog Image Keys',
  product: 'WhatsApp Product Keys',
  ptt: 'WhatsApp Audio Keys',
  'thumbnail-link': 'WhatsApp Link Keys',
  'md-app-state': 'WhatsApp App State Keys',
};

export function getMediaHkdfInfo(mediaType: MediaType): string {
  return MEDIA_HKDF_INFO[mediaType];
}

/** Upload path segments on the media server, e.g. `mms/image` */
export function getUploadPath(mediaType: MediaType): string {
  const map: Record<MediaType, string> = {
    image: 'image',
    video: 'video',
    audio: 'audio',
    document: 'document',
    sticker: 'image',
    history: 'history',
    'md-msg-hist': 'history',
    'link-preview': 'thumbnail-link',
    'product-catalog-image': 'product-catalog-image',
    product: 'document',
    ptt: 'ptt',
    'thumbnail-link': 'thumbnail-link',
    'md-app-state': 'md-app-state',
  };
  return `mms/${map[mediaType]}`;
}

/** Guess the media class for a payload (used by the downloader) */
export function getMediaType(payload: { mimetype?: string }, defaultType: MediaType = 'document'): MediaType {
  const mime = payload.mimetype ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return defaultType;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  pdf: 'application/pdf',
  zip: 'application/zip',
  txt: 'text/plain',
  json: 'application/json',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function detectMimeType(fileName: string, fallback = 'application/octet-stream'): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? fallback;
}
