/**
 * Turning parsed document text into citable chunks.
 *
 * The chunk is the unit of retrieval and of citation, so its boundaries decide
 * how precise a page reference can be. Two rules follow from that:
 *
 *   - A chunk never spans pages. Keeping `page` single-valued means every
 *     citation the model produces points at one page a reviewer can open.
 *   - A chunk is sized for a prompt, not for storage. Too small and a policy
 *     threshold is separated from the sentence that qualifies it; too large and
 *     retrieval returns mostly irrelevant text and crowds out real evidence.
 *
 * Splitting prefers paragraph and sentence boundaries so a chunk does not end
 * mid-clause, which is where an extracted "fact" becomes a fragment.
 */
import { env } from '../../config/env';
import type { DocumentChunkRecord } from '@eclens/shared';

export interface PageText {
  /** 1-based page number as reported by the parser. */
  num: number;
  text: string;
}

/** Rough tokens from characters. Only used to bound prompt size, never billed. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const HEADING_MAX_LENGTH = 90;

/**
 * A heading is a short line that does not end like a sentence. Numbered
 * clauses ("5.5.3 Significant increase in credit risk") and title-case lines
 * both qualify; this is a heuristic for labelling, not for retrieval, so a
 * false positive only costs a slightly odd label.
 */
function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > HEADING_MAX_LENGTH) return false;
  if (/[.!?]$/.test(trimmed)) return false;
  if (/\s{3,}/.test(trimmed)) return false;
  return (
    /^(\d+(\.\d+)*\s+\S)/.test(trimmed) ||
    /^(appendix|annex|section|chapter|part|table|figure|note)\b/i.test(trimmed) ||
    trimmed === trimmed.toUpperCase() ||
    /^[A-Z][^.]*$/.test(trimmed)
  );
}

/** Splits a page into blocks at blank lines, falling back to sentences. */
function blocksOf(pageText: string): string[] {
  const paragraphs = pageText
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter((block) => block.length > 0);

  if (paragraphs.length > 0) return paragraphs;

  // No blank lines: a scanned or single-spaced page. Split on sentence ends so
  // the chunker still has units smaller than the whole page to work with.
  return pageText
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export interface ChunkOptions {
  maxChars?: number;
}

/**
 * Chunks page text into `DocumentChunkRecord`s, assigning a dense ordinal across
 * the whole document so a citation can be ordered and de-duplicated.
 */
export function chunkDocumentPages(pages: PageText[], options: ChunkOptions = {}): DocumentChunkRecord[] {
  const maxChars = options.maxChars ?? env.DOCUMENT_AI_CHUNK_CHARS;
  const chunks: DocumentChunkRecord[] = [];
  let ordinal = 0;

  for (const page of pages) {
    let buffer = '';
    let heading: string | null = null;
    let bufferHeading: string | null = null;

    const flush = (): void => {
      const text = buffer.trim();
      buffer = '';
      if (text.length === 0) {
        bufferHeading = null;
        return;
      }
      chunks.push({
        ordinal: ordinal++,
        page: page.num,
        heading: bufferHeading,
        text,
        tokenEstimate: estimateTokens(text),
      });
      bufferHeading = null;
    };

    for (const block of blocksOf(page.text)) {
      if (looksLikeHeading(block) && block.length <= HEADING_MAX_LENGTH) {
        heading = block;
        // A heading starts a new chunk: it belongs with the text that follows
        // it, not with whatever preceded it.
        if (buffer.trim().length > 0) flush();
        bufferHeading = heading;
        buffer = block;
        continue;
      }

      if (buffer.length + block.length + 1 > maxChars && buffer.trim().length > 0) {
        flush();
        bufferHeading = heading;
      }

      // A single block larger than the budget is split hard rather than
      // dropped; losing a page's content would silently narrow the evidence.
      if (block.length > maxChars) {
        if (buffer.trim().length > 0) flush();
        for (let start = 0; start < block.length; start += maxChars) {
          const slice = block.slice(start, start + maxChars).trim();
          if (slice.length === 0) continue;
          chunks.push({
            ordinal: ordinal++,
            page: page.num,
            heading: bufferHeading ?? heading,
            text: slice,
            tokenEstimate: estimateTokens(slice),
          });
        }
        buffer = '';
        bufferHeading = null;
        continue;
      }

      buffer = buffer.length === 0 ? block : `${buffer} ${block}`;
      if (bufferHeading === null) bufferHeading = heading;
    }

    flush();
  }

  return chunks;
}
