import { PDFName } from 'pdf-lib';

/**
 * Encode a user supplied PDF name for use as an operand in a content stream.
 *
 * PDF resource dictionaries already take PDFName instances, but operators are
 * assembled as text.  Interpolating a raw spot name there breaks as soon as it
 * contains whitespace, a slash, or a character such as "#".  pdf-lib's name
 * serializer applies the PDF #xx escaping rules required by both locations.
 */
export function pdfName(name: string): PDFName {
  // PDFName.of() treats an input sequence such as "#20" as an already
  // escaped space when decoding. Escape literal hash characters first so
  // names like "Die#20Line" round-trip byte-for-byte.
  return PDFName.of(name.replaceAll('#', '#23'));
}

export function pdfNameToken(name: string): string {
  return pdfName(name).toString();
}

/** Stable, non-ambiguous marker used to round-trip our custom contour label. */
export function cutContourMetadata(labels: readonly string[]): string {
  return `CutContourLabels:${labels.map(label => encodeURIComponent(label.trim())).join(',')}`;
}

export function readCutContourMetadata(subject: string | undefined): string[] {
  const encoded = subject?.match(/(?:^|\s)CutContourLabels:([^\s]+)/)?.[1];
  if (!encoded) return [];
  return encoded.split(',').map(value => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }).filter(Boolean);
}