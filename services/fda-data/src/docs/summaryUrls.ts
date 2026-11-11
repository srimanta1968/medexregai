/**
 * Where the FDA publishes a 510(k) summary PDF, by K-number.
 *
 * Checked against accessdata.fda.gov on 2026-11-11 with one cleared "Summary" record
 * per year: from K02 on the PDF is at cdrh_docs/pdf{YY without a leading zero}/{K}.pdf
 * (pdf2, pdf5, pdf9, pdf10, pdf15, pdf20, pdf23, pdf25 answered 200 application/pdf);
 * the K99 sample was at cdrh_docs/pdf/{K}.pdf; the K95, K00 and K01 samples were at
 * neither. Older records are therefore tried at cdrh_docs/pdf/ only, and a 404 at every
 * candidate means "no summary on file".
 */

const BASE = 'https://www.accessdata.fda.gov/cdrh_docs';
const K_NUMBER = /^K(\d{2})\d{4}$/;

/** True for a 510(k) number (K + 6 digits). De Novo (DEN) numbers have no summary PDF here. */
export function isKNumber(kNumber: string): boolean {
  return K_NUMBER.test(kNumber);
}

/** Candidate summary URLs, most likely first. Empty for anything that is not a K-number. */
export function summaryUrls(kNumber: string): string[] {
  const m = K_NUMBER.exec(kNumber);
  if (!m) return [];
  const yy = Number(m[1]);
  // Two-digit years 76-99 are 1976-1999; 00-75 are 2000 onwards.
  const year = yy >= 76 ? 1900 + yy : 2000 + yy;
  if (year >= 2002) return [`${BASE}/pdf${yy}/${kNumber}.pdf`];
  return [`${BASE}/pdf/${kNumber}.pdf`];
}
