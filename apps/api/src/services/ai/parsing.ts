/**
 * Reading uploaded bytes into page text a citation can point at.
 *
 * PDF only. That is a deliberate limit rather than an oversight: a PDF carries
 * its own page boundaries, so every extracted fact and every proposed signal can
 * name the page a reviewer should open. CSV and XLSX have no such structure and
 * already have a pipeline that understands them — the import path validates,
 * quarantines and commits rows — so routing a spreadsheet through here would
 * duplicate that work and lose its guarantees.
 *
 * Two checks run before the parser is trusted with the bytes. The declared MIME
 * type is a claim made by the client and costs nothing to forge; the leading
 * `%PDF-` signature is a fact about the file. Both must agree, because a
 * mislabelled file that still parses is usually a mistake, while a correctly
 * labelled file that does not is usually an attempt.
 */
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import { AiError, documentParseFailed, documentUnsupportedType } from './aiErrors';
import { sanitizeUntrustedText } from './untrusted';
import type { PageText } from './chunking';

export const PDF_MIME_TYPE = 'application/pdf';

/** Leading bytes of every conforming PDF. Checked because `file.mimetype` is client-supplied. */
const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1');

/**
 * The longest document text sent to the model in one extraction.
 *
 * Bounded independently of `AI_MAX_EVIDENCE_CHARS`, which governs a single
 * evidence block: a 400-page policy is not made safe by truncating one block,
 * and a truncated document must say so rather than let the model report an
 * absence as a finding.
 */
export const MAX_EXTRACTION_CHARS = 120_000;

export function isPdfSignature(buffer: Buffer): boolean {
  return buffer.length >= PDF_SIGNATURE.length && buffer.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE);
}

/**
 * A display name that cannot escape the JSON it is embedded in or the log line it
 * is quoted in.
 *
 * The uploaded bytes are never written to disk, so this name is never a path —
 * it is rendered in responses, stored on the document row, and quoted in audit
 * detail. Each of those is reason enough to strip control characters.
 */
export function safeDocumentName(originalName: string, fallback = 'uploaded-document.pdf'): string {
  const base = path.basename(String(originalName ?? '').replace(/\\/g, '/'));
  // Filtered by code point rather than by a regex range: C0 controls and DEL in a
  // filename are how a name smuggles a terminal escape or a newline into a log
  // line, and the intent reads better as a predicate than as a character class.
  const isPrintable = (character: string): boolean => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  };
  const withoutControl = [...base].filter(isPrintable).join('').trim();
  const collapsed = withoutControl.replace(/\s+/g, ' ').slice(0, 160);
  return collapsed.length > 0 ? collapsed : fallback;
}

/**
 * Extracts page text from PDF bytes.
 *
 * Throws `AiError` rather than a parser error: the caller turns failures into a
 * stored `FAILED` status with a message a reviewer can act on, and a raw pdf.js
 * message names internals that mean nothing to an analyst and may quote the
 * document back.
 */
export async function parsePdfPages(buffer: Buffer, name: string): Promise<PageText[]> {
  if (!isPdfSignature(buffer)) {
    throw documentUnsupportedType(
      `'${name}' is not a PDF: the file does not begin with the %PDF- signature. Upload a PDF; spreadsheet data belongs in the portfolio import.`,
    );
  }

  const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false, disableFontFace: true });
  try {
    const result = await parser.getText();
    const pages = result.pages
      .map((page) => ({ num: page.num, text: sanitizeUntrustedText(page.text) }))
      .filter((page) => page.text.length > 0);

    if (pages.length === 0) {
      throw documentParseFailed(
        `'${name}' parsed but produced no readable text. It is probably a scan; an image-only PDF needs OCR, which this deployment does not perform.`,
      );
    }
    return pages;
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw documentParseFailed(`'${name}' could not be read as a PDF. The file may be corrupt, encrypted or password-protected.`);
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

export interface ExtractionCorpus {
  /** Page text within the character budget, in page order. */
  pages: PageText[];
  /** Pages present in the document but withheld from the model. */
  omittedPages: number;
  /** Characters withheld, for the caveat that says the read was partial. */
  omittedChars: number;
  totalChars: number;
}

/**
 * The slice of a document an extraction is allowed to read.
 *
 * Fills page by page until the budget is spent, and reports exactly what was
 * left out. Reporting matters more than the limit itself: a model told about a
 * page it never saw will say so, while a model silently given half a document
 * will describe the missing half as absent.
 */
export function extractionCorpus(pages: readonly PageText[], maxChars = MAX_EXTRACTION_CHARS): ExtractionCorpus {
  const kept: PageText[] = [];
  let used = 0;
  let omittedPages = 0;
  let omittedChars = 0;
  const totalChars = pages.reduce((total, page) => total + page.text.length, 0);

  for (const page of pages) {
    if (used + page.text.length > maxChars && kept.length > 0) {
      omittedPages += 1;
      omittedChars += page.text.length;
      continue;
    }
    kept.push(page);
    used += page.text.length;
  }

  return { pages: kept, omittedPages, omittedChars, totalChars };
}
