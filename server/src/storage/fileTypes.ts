import { AppError, ErrorCodes } from '../utils/AppError';

/**
 * Which files a client may upload through a link (F2.4): the formats the ingest
 * pipeline reads (Word, Excel, PowerPoint, PDF, CSV and text, and images for OCR).
 * The file's first bytes must match its extension, so an executable renamed to
 * report.pdf is refused.
 */

interface Kind {
  label: string;
  extensions: string[];
  matches: (head: Buffer) => boolean;
}

const startsWith = (head: Buffer, ...sig: number[]): boolean => sig.every((b, i) => head[i] === b);
const ZIP = (h: Buffer): boolean => startsWith(h, 0x50, 0x4b, 0x03, 0x04);
const looksLikeText = (h: Buffer): boolean => {
  if (h.length === 0) return false;
  // UTF-8 / ASCII text: no NUL bytes and no other control characters except tab, CR, LF, FF.
  for (const b of h) {
    if (b === 0) return false;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) return false;
  }
  return true;
};

const KINDS: Kind[] = [
  { label: 'PDF', extensions: ['pdf'], matches: (h) => startsWith(h, 0x25, 0x50, 0x44, 0x46, 0x2d) },
  { label: 'Word, Excel or PowerPoint', extensions: ['docx', 'xlsx', 'pptx', 'docm', 'xlsm'], matches: ZIP },
  { label: 'CSV or text', extensions: ['csv', 'txt', 'tsv'], matches: looksLikeText },
  { label: 'JPEG image', extensions: ['jpg', 'jpeg'], matches: (h) => startsWith(h, 0xff, 0xd8, 0xff) },
  { label: 'PNG image', extensions: ['png'], matches: (h) => startsWith(h, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) },
  { label: 'TIFF image', extensions: ['tif', 'tiff'], matches: (h) => startsWith(h, 0x49, 0x49, 0x2a, 0x00) || startsWith(h, 0x4d, 0x4d, 0x00, 0x2a) },
];

export const ACCEPTED_EXTENSIONS = KINDS.flatMap((k) => k.extensions);
export const ACCEPTED_LABEL = 'PDF, Word, Excel, PowerPoint, CSV or text, and JPEG, PNG or TIFF images';

/** Throws UNSUPPORTED_FILE_TYPE (415) unless the name and the bytes agree on an accepted format. */
export function assertAcceptedUpload(name: string, bytes: Buffer): string {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const kind = KINDS.find((k) => k.extensions.includes(ext));
  if (!kind) {
    throw new AppError(415, ErrorCodes.UNSUPPORTED_FILE_TYPE, `This type of file cannot be uploaded. Accepted: ${ACCEPTED_LABEL}.`, [
      { field: 'file', message: ext ? `.${ext} files are not accepted` : 'The file name has no extension' },
    ]);
  }
  if (!kind.matches(bytes.subarray(0, 512))) {
    throw new AppError(415, ErrorCodes.UNSUPPORTED_FILE_TYPE, `The file's contents do not match its name: it is not a ${kind.label} file.`, [
      { field: 'file', message: `Contents are not ${kind.label}` },
    ]);
  }
  return kind.label;
}
