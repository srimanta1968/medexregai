/**
 * Why a file could not be read, as a stable kind plus words the consultant sees
 * (F2.2: unreadable files are listed with the reason, never skipped).
 */

export type UnreadableKind =
  | 'native_cad'
  | 'password_protected'
  | 'legacy_office'
  | 'unsupported_format'
  | 'corrupt'
  | 'too_large'
  | 'no_text'
  | 'parse_timeout'
  | 'not_stored';

export const UNREADABLE_LABEL: Record<UnreadableKind, string> = {
  native_cad: 'Native CAD',
  password_protected: 'Password protected',
  legacy_office: 'Old Office format',
  unsupported_format: 'File type not read',
  corrupt: 'Damaged or unreadable',
  too_large: 'Too large',
  no_text: 'No text (scanned)',
  parse_timeout: 'Took too long to read',
  not_stored: 'Copy missing',
};

/** What to do about it, in plain words. */
export const UNREADABLE_ADVICE: Record<UnreadableKind, string> = {
  native_cad: 'CAD models are listed only. Ask the client for a PDF drawing with the title block.',
  password_protected: 'Ask the client for a copy without a password.',
  legacy_office: 'Ask for the file saved as .docx, .xlsx or .pptx.',
  unsupported_format: 'Ask for a PDF, Word, Excel, PowerPoint, CSV or image copy.',
  corrupt: 'The file may be damaged. Ask the client to send it again.',
  too_large: 'Ask for a smaller file, or split it into parts.',
  no_text: 'The pages are images without text. Ask for a text PDF, or turn on OCR.',
  parse_timeout: 'Reading took too long. Try again later or ask for a simpler copy.',
  not_stored: 'Our copy is missing. Add the file again.',
};

/** Native CAD and model formats seen in device design folders. */
const CAD_EXTENSIONS = new Set([
  'sldprt', 'sldasm', 'slddrw', 'step', 'stp', 'iges', 'igs', 'dwg', 'dxf', 'prt', 'asm', 'catpart', 'catproduct',
  'x_t', 'x_b', 'ipt', 'iam', 'idw', 'par', 'psm', '3dm', 'stl', 'f3d', 'jt', 'sat', 'neu',
]);
const LEGACY_OFFICE = new Set(['doc', 'xls', 'ppt']);

const ext = (name: string): string => /\.([a-z0-9_]{1,12})$/i.exec(name)?.[1]?.toLowerCase() ?? '';

export const isCadFile = (name: string): boolean => CAD_EXTENSIONS.has(ext(name));

/** A file refused before it was stored (type check, size limit). */
export function classifyRefusal(name: string, reason: 'type' | 'size'): UnreadableKind {
  if (reason === 'size') return 'too_large';
  if (isCadFile(name)) return 'native_cad';
  if (LEGACY_OFFICE.has(ext(name))) return 'legacy_office';
  return 'unsupported_format';
}

/** A parse failure, from the docproc error code and message (services/docproc/docproc/errors.py). */
export function classifyParseFailure(code: string | null, message: string, name: string): UnreadableKind {
  if (/password/i.test(message)) return 'password_protected';
  if (code === 'FILE_TOO_LARGE' || code === 'ARCHIVE_LIMIT') return 'too_large';
  if (code === 'PARSE_TIMEOUT') return 'parse_timeout';
  if (code === 'UNSUPPORTED_FORMAT') return classifyRefusal(name, 'type');
  if (code === 'FILE_UNREADABLE') return 'corrupt';
  if (/stored copy .*missing|No stored copy/i.test(message)) return 'not_stored';
  return 'corrupt';
}
