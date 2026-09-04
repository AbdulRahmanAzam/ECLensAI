/**
 * Feature 6 — document intelligence, and the document library it reads from.
 *
 * Five decisions shape this module, and each one is a refusal to let a document
 * become a way around the rest of the product:
 *
 *   - **Indexing and extraction are separate acts.** Chunking a PDF needs no
 *     model, so an upload is citable on a deployment with no API key; extraction
 *     does need one, and says so instead of failing the upload. That split is
 *     why `POST /documents` never returns an AI error.
 *   - **The bytes are not kept.** Parsing produces page text, the text becomes
 *     chunks, and the upload is discarded — the same stance the portfolio import
 *     takes. What a citation needs is the page and the quote, both of which are
 *     stored; retaining untrusted PDFs on the API host would add a liability
 *     with no reader, since no endpoint serves the original back.
 *   - **Every claim is checked against the text the model was actually given.**
 *     A quote that does not appear there is dropped rather than corrected, and a
 *     fact marked `verbatim` whose value is absent is dropped outright. This is
 *     the document analogue of the numeric grounding guard: the guard catches an
 *     invented figure, this catches an invented quotation.
 *   - **Signals are inert.** Accepting one records a human decision and writes an
 *     audit event. It creates no exception, changes no stage, and touches no
 *     exposure row — the existing mutation paths remain the only way to move a
 *     number, and they keep their own permissions and reviews.
 *   - **Chunk text is never served.** `GET /documents/:id` returns the extraction
 *     and its citations, not the corpus, so a licensed guidance PDF uploaded for
 *     retrieval cannot be read back out through this API one chunk at a time.
 */
import { createHash } from 'node:crypto';
import type { Document as DocumentRow, DocumentSignal as DocumentSignalRow, Prisma } from '@prisma/client';
import {
  aiModelDocumentExtractionSchema,
  type AiResponse,
  type AiSourceRef,
  type DocumentCitation,
  type DocumentCategory,
  type DocumentExtraction,
  type DocumentExtractRequest,
  type DocumentListQuery,
  type DocumentListResponse,
  type DocumentProcessingStatus,
  type DocumentRecord,
  type DocumentSignalRecord,
  type DocumentSignalStatus,
  type DocumentUploadRequest,
  type DocumentUploadResponse,
  type ExtractedFact,
  type ProposedRiskSignal,
  type SignalDecisionRequest,
} from '@eclens/shared';
import { env } from '../config/env';
import { recordAudit, type AuditActor } from '../lib/audit';
import { newId, newPublicId } from '../lib/ids';
import { logger } from '../lib/logger';
import { buildPageMeta, containsSearch, orderBy, toPageArgs } from '../lib/pagination';
import { prisma } from '../lib/prisma';
import { HttpError, notFound } from '../utils/httpError';
import { aiAvailability } from './ai/availability';
import { aiEvidenceMissing, documentSignalAlreadyDecided, documentUnsupportedType } from './ai/aiErrors';
import { chunkDocumentPages } from './ai/chunking';
import { withAiEnvelope } from './ai/envelope';
import { extractionCorpus, isPdfSignature, parsePdfPages, PDF_MIME_TYPE, safeDocumentName } from './ai/parsing';
import { createRedactor, toLogSafe, type DataCategory, type Redactor } from './ai/redaction';
import { indexDocumentChunks, type KnowledgeRetriever } from './ai/retrieval';
import { runAiFeature } from './ai/runner';
import { assertActorPermission, sourceRef } from './ai/tools';
import { findInjectionAttempts, injectionWarnings } from './ai/untrusted';
import type { PageText } from './ai/chunking';
import type { GeminiClient } from './ai/geminiClient';

type DocumentWithSignals = DocumentRow & { signals: DocumentSignalRow[] };

const DOCUMENT_INCLUDE = { signals: { orderBy: { createdAt: 'asc' } } } as const;

/** Upper bound on reviewer-facing warnings, so a hostile document cannot pad the response. */
const MAX_WARNINGS = 24;
/** How much of a supporting quote must match before it counts as present. */
const MIN_QUOTE_CHARS = 12;

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function toSignalRecord(row: DocumentSignalRow): DocumentSignalRecord {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    detail: row.detail,
    // Prisma's enum and the wire union hold the same literals but are nominally
    // distinct types, so the cast is required. Same pattern as every other
    // record mapper in this API.
    severity: row.severity as DocumentSignalRecord['severity'],
    page: row.page,
    supportingText: row.supportingText,
    status: row.status as DocumentSignalStatus,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionNote: row.decisionNote,
  };
}

/**
 * Re-validates a stored extraction on the way out.
 *
 * It was validated before it was written, so this normally costs one parse of an
 * object already in memory. It is here because the alternative — trusting a JSON
 * column — means a hand-edited row or a schema change between releases reaches a
 * reviewer as fact. A row that no longer validates degrades to "no extraction".
 */
function parseStoredExtraction(value: Prisma.JsonValue | null, publicId: string): DocumentExtraction | null {
  if (value === null || typeof value !== 'object') return null;
  const parsed = aiModelDocumentExtractionSchema.safeParse(value);
  if (!parsed.success) {
    logger.warn({ publicId, issues: parsed.error.issues.length }, 'Stored document extraction no longer matches its schema; withholding it');
    return null;
  }
  return { ...parsed.data, requiresApproval: true };
}

function toDocumentRecord(row: DocumentWithSignals): DocumentRecord {
  return {
    id: row.publicId,
    publicId: row.publicId,
    name: row.name,
    category: row.category as DocumentCategory,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    pageCount: row.pageCount,
    chunkCount: row.chunkCount,
    processingStatus: row.processingStatus as DocumentProcessingStatus,
    message: row.message,
    documentType: row.documentType,
    summary: row.summary,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    extraction: parseStoredExtraction(row.extraction, row.publicId),
    signals: row.signals.map(toSignalRecord),
    seeded: row.seeded,
  };
}

async function findDocument(organizationId: string, publicId: string): Promise<DocumentWithSignals> {
  const row = await prisma.document.findFirst({
    where: { organizationId, publicId },
    include: DOCUMENT_INCLUDE,
  });
  if (!row) throw notFound('No document matches that id in your organisation');
  return row;
}

// ---------------------------------------------------------------------------
// Upload and indexing
// ---------------------------------------------------------------------------

export interface UploadDocumentOptions {
  retriever?: KnowledgeRetriever;
}

/**
 * Validates, parses, chunks and indexes one upload. Never calls a model.
 *
 * The file arrives in memory and leaves this function as database rows: the
 * buffer is not written to disk, so there is no window in which an untrusted PDF
 * exists on the API host's filesystem.
 */
export async function uploadDocument(
  actor: AuditActor,
  file: Express.Multer.File,
  input: DocumentUploadRequest,
  options: UploadDocumentOptions = {},
): Promise<DocumentUploadResponse> {
  assertActorPermission(actor, 'document:write', 'upload a document');

  const name = safeDocumentName(input.name ?? file.originalname);

  if (file.size > env.DOCUMENT_AI_MAX_BYTES) {
    throw new HttpError(
      413,
      'UPLOAD_TOO_LARGE',
      `'${name}' is ${file.size} bytes; the document limit is ${env.DOCUMENT_AI_MAX_BYTES} bytes.`,
    );
  }
  // Checked before the signature because a wrong MIME type is the cheaper and
  // clearer thing to tell the user, and multer has already bounded the bytes.
  if (file.mimetype !== PDF_MIME_TYPE) {
    throw documentUnsupportedType(
      `'${name}' was sent as '${file.mimetype || 'unknown'}'. Only PDF documents can be indexed here; spreadsheet data belongs in the portfolio import.`,
    );
  }
  if (!isPdfSignature(file.buffer)) {
    throw documentUnsupportedType(`'${name}' is labelled a PDF but does not begin with the %PDF- signature, so it was rejected.`);
  }

  const sha256 = createHash('sha256').update(file.buffer).digest('hex');
  const duplicate = await prisma.document.findFirst({
    where: { organizationId: actor.organizationId, sha256 },
    include: DOCUMENT_INCLUDE,
  });
  if (duplicate) {
    await recordAudit({
      organizationId: actor.organizationId,
      actor,
      action: 'AI.DOCUMENT_UPLOAD_DUPLICATE',
      entityType: 'Document',
      entityId: duplicate.publicId,
      detail: `Re-upload of identical bytes declined; the existing document '${toLogSafe(duplicate.name)}' was returned instead of indexing a second copy.`,
    });
    return { document: toDocumentRecord(duplicate), duplicateOf: duplicate.publicId, availability: aiAvailability() };
  }

  let pages: PageText[];
  try {
    pages = await parsePdfPages(file.buffer, name);
  } catch (error) {
    logger.warn({ err: error, actorId: actor.id, name: toLogSafe(name) }, 'Document upload rejected during parsing');
    throw error;
  }

  const chunks = chunkDocumentPages(pages);
  const availability = aiAvailability();
  const message =
    `Parsed ${pages.length} page(s) into ${chunks.length} retrievable chunk(s).` +
    (availability.available
      ? ' Extraction has not run yet — open the document to extract facts and proposed signals.'
      : ` ${availability.message}`);

  const id = newId();
  const publicId = newPublicId('DOC');
  const created = await prisma.document.create({
    data: {
      id,
      organizationId: actor.organizationId,
      publicId,
      name,
      category: input.category,
      mimeType: PDF_MIME_TYPE,
      sizeBytes: file.size,
      sha256,
      // No bytes are retained, so there is no key. Nullable by design: the
      // derived text is the artefact, and a stored file nobody can download
      // would be a liability rather than a feature.
      storageKey: null,
      pageCount: pages.length,
      chunkCount: chunks.length,
      processingStatus: 'INDEXED',
      message,
      uploadedById: actor.id,
      uploadedBy: actor.fullName,
    },
    include: DOCUMENT_INCLUDE,
  });

  await indexDocumentChunks(actor.organizationId, id, chunks, options.retriever);

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'AI.DOCUMENT_UPLOADED',
    entityType: 'Document',
    entityId: publicId,
    detail:
      `Uploaded '${toLogSafe(name)}' (${input.category}, ${file.size} bytes, ${pages.length} page(s), ` +
      `${chunks.length} chunk(s), sha256 ${sha256.slice(0, 12)}…). Indexed for retrieval; no extraction run, no signal created.`,
  });

  return { document: toDocumentRecord(created), duplicateOf: null, availability };
}

export async function listDocuments(actor: AuditActor, query: DocumentListQuery): Promise<DocumentListResponse> {
  assertActorPermission(actor, 'document:read', 'list documents');

  const term = query.search?.trim();
  const where: Prisma.DocumentWhereInput = {
    organizationId: actor.organizationId,
    ...(query.category ? { category: query.category } : {}),
    ...(query.processingStatus ? { processingStatus: query.processingStatus } : {}),
    ...(term ? { OR: [...(containsSearch(term, ['name', 'documentType', 'summary']) ?? [])] } : {}),
  };

  const pageArgs = toPageArgs(query);
  const [totalItems, rows] = await Promise.all([
    prisma.document.count({ where }),
    prisma.document.findMany({
      where,
      include: DOCUMENT_INCLUDE,
      ...pageArgs,
      orderBy: orderBy(query.sortBy, query.sortDir, ['name', 'category', 'createdAt', 'updatedAt', 'sizeBytes'], {
        createdAt: 'desc',
      }),
    }),
  ]);

  return {
    items: rows.map(toDocumentRecord),
    meta: buildPageMeta(query, totalItems),
    availability: aiAvailability(),
  };
}

export async function getDocument(actor: AuditActor, publicId: string): Promise<DocumentRecord> {
  assertActorPermission(actor, 'document:read', 'open a document');
  return toDocumentRecord(await findDocument(actor.organizationId, publicId));
}

/**
 * Removes a document, its chunks and its signals.
 *
 * Deleting also removes any human decisions recorded against it, which is why
 * the permission is `document:delete` — held by ADMIN alone — rather than the
 * `document:write` that uploading uses. The audit event keeps the fact that the
 * document existed and who removed it; the ledger itself is append-only.
 */
export async function deleteDocument(actor: AuditActor, publicId: string): Promise<void> {
  assertActorPermission(actor, 'document:delete', 'delete a document');

  const row = await findDocument(actor.organizationId, publicId);
  if (row.seeded) {
    throw new HttpError(
      409,
      'DOCUMENT_SEEDED',
      'That document is part of the seeded governance library and cannot be deleted. Upload your own policy material to add to retrieval.',
    );
  }

  const chunkCount = row.chunkCount;
  const decided = row.signals.filter((signal) => signal.status !== 'PROPOSED').length;
  await prisma.document.delete({ where: { id: row.id } });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'AI.DOCUMENT_DELETED',
    entityType: 'Document',
    entityId: publicId,
    detail:
      `Deleted '${toLogSafe(row.name)}' with ${chunkCount} indexed chunk(s) and ${row.signals.length} proposed signal(s), ` +
      `${decided} of which had already been decided by a person. Removed from retrieval.`,
  });
}

// ---------------------------------------------------------------------------
// Feature 6 — extraction
// ---------------------------------------------------------------------------

export interface ExtractDocumentOptions {
  client?: GeminiClient;
  retriever?: KnowledgeRetriever;
  requestId?: string | null;
}

/** Whitespace-collapsed, for comparing a quote against the document. */
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** Collapsed and case-folded: a quote may differ in capitalisation and still be real. */
const fold = (text: string): string => collapse(text).toLowerCase();

interface Corpus {
  /** Page text the model was given, in page order. */
  pages: PageText[];
  /** Case-folded text of exactly those pages, for quote verification. */
  searchable: string;
  /** Case-preserving text of exactly those pages, for verbatim verification. */
  verbatim: string;
}

function buildCorpus(pages: PageText[]): Corpus {
  const all = pages.map((page) => page.text).join('\n\n');
  return { pages, searchable: fold(all), verbatim: collapse(all) };
}

/**
 * Rebuilds page text from stored chunks.
 *
 * Chunks are the persisted form of the document — the bytes are not kept — so a
 * re-extraction reads the same text the first extraction saw, page by page.
 */
function pagesFromChunks(rows: Array<{ ordinal: number; page: number | null; text: string }>): PageText[] {
  const byPage = new Map<number, string[]>();
  const unpaged: string[] = [];
  for (const row of [...rows].sort((a, b) => a.ordinal - b.ordinal)) {
    if (row.page === null) unpaged.push(row.text);
    else byPage.set(row.page, [...(byPage.get(row.page) ?? []), row.text]);
  }

  const pages: PageText[] = [...byPage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([num, texts]) => ({ num, text: texts.join('\n\n') }));
  // Page 0 is not a real page: it collects any chunk the parser could not place,
  // so its text is still read and still verifiable rather than silently lost.
  if (unpaged.length > 0) pages.push({ num: 0, text: unpaged.join('\n\n') });
  return pages;
}

function pageEvidenceBlock(documentPublicId: string, page: PageText, redactor: Redactor): string {
  const label = page.num > 0 ? `DOCUMENT ${documentPublicId} PAGE ${page.num}` : `DOCUMENT ${documentPublicId} UNPAGED`;
  return `<<<EVIDENCE ${label}\n${redactor.applyToText(page.text)}\nEVIDENCE ${label}>>>`;
}

/** What the model produced: the wire extraction minus the approval flag the service adds. */
type ModelExtraction = Omit<DocumentExtraction, 'requiresApproval'>;

interface GateContext {
  documentPublicId: string;
  documentName: string;
  /** Highest page number that exists, so a citation can be checked against it. */
  maxPage: number;
  corpus: Corpus;
  /** Warnings that do not come from the gate: truncation, injection findings. */
  leadingWarnings: string[];
}

interface GatedExtraction {
  extraction: DocumentExtraction;
  droppedFacts: number;
  droppedSignals: number;
  droppedCitations: number;
}

/**
 * Returns the page number only when the document really has that page.
 *
 * A wrong page is stripped rather than the item dropped: the quote was verified
 * against the text, so the finding is real and only its locator is wrong. Losing
 * the finding would hide something true; keeping the locator would send a
 * reviewer to the wrong page.
 */
function verifiedPage(page: number | undefined, context: GateContext, warnings: string[], what: string): number | undefined {
  if (page === undefined || page === null) return undefined;
  if (page >= 1 && page <= context.maxPage) return page;
  warnings.push(`${what} cited page ${page}, which this document does not have (it has ${context.maxPage}). The page reference was removed.`);
  return undefined;
}

function present(quote: string, context: GateContext): boolean {
  // A quote shorter than this can match by accident — "the Bank", "2023" — and
  // an accidental match is worse than no check, because it looks verified.
  if (collapse(quote).length < MIN_QUOTE_CHARS) return false;
  return context.corpus.searchable.includes(fold(quote));
}

/**
 * Verifies a model extraction against the document before any of it is stored.
 *
 * Drops rather than repairs, on a simple principle: a claim this function cannot
 * verify is a claim no reviewer can verify either, and an extraction with one
 * fabricated quote in it discredits the nine that are real.
 */
function gateExtraction(model: ModelExtraction, context: GateContext): GatedExtraction {
  const warnings: string[] = [];
  const facts: ExtractedFact[] = [];
  const signals: ProposedRiskSignal[] = [];
  const citations: DocumentCitation[] = [];
  let droppedFacts = 0;
  let droppedSignals = 0;
  let droppedCitations = 0;

  for (const fact of model.extractedFacts) {
    if (fact.verbatim && !context.corpus.verbatim.includes(collapse(fact.value))) {
      droppedFacts += 1;
      warnings.push(
        `The fact '${fact.label}' was marked verbatim, but its value does not appear in the pages that were read, so it was dropped rather than shown.`,
      );
      continue;
    }
    // Destructured out rather than overwritten: a conditional spread adds a key,
    // it cannot remove one, so the unverified locator would otherwise survive.
    const { page: claimedPage, ...rest } = fact;
    const page = verifiedPage(claimedPage, context, warnings, `The fact '${fact.label}'`);
    facts.push({ ...rest, ...(page ? { page } : {}) });
  }

  for (const signal of model.proposedRiskSignals) {
    if (!present(signal.supportingText, context)) {
      droppedSignals += 1;
      warnings.push(
        `A proposed signal ('${signal.title}') quoted supporting text that does not appear in the pages that were read, so it was not stored.`,
      );
      continue;
    }
    const { page: claimedPage, ...rest } = signal;
    const page = verifiedPage(claimedPage, context, warnings, `The signal '${signal.title}'`);
    signals.push({ ...rest, ...(page ? { page } : {}) });
  }

  for (const citation of model.citations) {
    if (!present(citation.quote, context)) {
      droppedCitations += 1;
      continue;
    }
    const page = verifiedPage(citation.page, context, warnings, 'A citation');
    // Identity is forced, not trusted: the model was given one document, so any
    // other name it supplies is invented, and an invented source is the one
    // failure a citation exists to prevent.
    citations.push({
      documentId: context.documentPublicId,
      documentName: context.documentName,
      ...(page ? { page } : {}),
      ...(citation.chunkOrdinal !== undefined ? { chunkOrdinal: citation.chunkOrdinal } : {}),
      quote: citation.quote,
    });
  }

  const deduped = [...new Set([...context.leadingWarnings, ...warnings, ...model.warnings])].slice(0, MAX_WARNINGS);

  return {
    extraction: {
      documentType: model.documentType,
      summary: model.summary,
      extractedFacts: facts,
      proposedRiskSignals: signals,
      citations,
      missingInformation: model.missingInformation,
      warnings: deduped,
      requiresApproval: true,
    },
    droppedFacts,
    droppedSignals,
    droppedCitations,
  };
}

/**
 * Reads one indexed document and proposes facts and risk signals from it.
 *
 * Returns the standard AI envelope: an unavailable model or a rejected response
 * arrives as `result: null` with an honest message rather than an HTTP error, so
 * the document screen stays usable and still shows what was indexed.
 */
export async function extractDocument(
  actor: AuditActor,
  publicId: string,
  request: DocumentExtractRequest,
  options: ExtractDocumentOptions = {},
): Promise<AiResponse<DocumentExtraction>> {
  const startedAt = Date.now();
  assertActorPermission(actor, 'document:write', 'extract findings from a document');

  return withAiEnvelope<DocumentExtraction>(
    {
      feature: 'DOCUMENT_INTELLIGENCE',
      startedAt,
      requestId: options.requestId ?? null,
      ...(options.client ? { client: options.client } : {}),
    },
    async () => {
      const row = await findDocument(actor.organizationId, publicId);

      if (row.processingStatus === 'FAILED' || row.processingStatus === 'UNSUPPORTED') {
        throw aiEvidenceMissing(`'${row.name}' was not indexed (${row.message}), so there is no text to read.`);
      }
      if (row.chunkCount === 0) {
        throw aiEvidenceMissing(`'${row.name}' has no indexed text, so there is nothing to extract from.`);
      }
      if (row.extraction !== null && !request.force) {
        throw new HttpError(
          409,
          'DOCUMENT_ALREADY_EXTRACTED',
          `'${row.name}' has already been extracted. Send force=true to read it again; signals still awaiting a decision will be replaced, and decisions already made are kept.`,
        );
      }

      const chunkRows = await prisma.documentChunk.findMany({
        where: { documentId: row.id, organizationId: actor.organizationId },
        select: { ordinal: true, page: true, text: true },
        orderBy: { ordinal: 'asc' },
      });
      const full = buildCorpus(pagesFromChunks(chunkRows));
      const bounded = extractionCorpus(full.pages);
      const corpus = buildCorpus(bounded.pages);

      const redactor = createRedactor();
      const categories: DataCategory[] = ['DOCUMENT_TEXT'];
      redactor.note(...categories);

      const leadingWarnings: string[] = [];
      if (bounded.omittedPages > 0) {
        leadingWarnings.push(
          `Only part of this document was read: ${bounded.omittedPages} page(s) and about ${bounded.omittedChars} character(s) were withheld to stay within the model input limit. ` +
            'Anything described as missing may simply be on a page that was not read.',
        );
      }
      const injection = injectionWarnings(findInjectionAttempts(full.pages.map((page) => page.text).join('\n')));
      leadingWarnings.push(...injection);

      const context: GateContext = {
        documentPublicId: row.publicId,
        documentName: row.name,
        maxPage: row.pageCount ?? corpus.pages.reduce((max, page) => Math.max(max, page.num), 0),
        corpus,
        leadingWarnings,
      };

      const evidence = corpus.pages.map((page) => pageEvidenceBlock(row.publicId, page, redactor));
      const refs: AiSourceRef[] = [
        sourceRef('DOCUMENT', row.publicId, row.name, row.pageCount ? `${row.pageCount} page(s)` : undefined),
      ];

      const prompt = [
        `Read the document '${row.name}' (${row.category}, ${corpus.pages.length} page(s) supplied) and extract what is actually in it.`,
        'Cite the page for every fact and every signal. Quote the supporting text exactly as it appears.',
        'Extract a ratio or metric only when it is written down — never compute one. If a value is not present, list it under missingInformation instead of estimating it.',
      ].join('\n');

      const run = await runAiFeature<ModelExtraction>({
        feature: 'DOCUMENT_INTELLIGENCE',
        actor,
        schema: aiModelDocumentExtractionSchema,
        prompt,
        evidence,
        knownSourceRefs: refs,
        dataCategories: categories,
        redactor,
        // Tools stay off: the document is the whole subject, and a model free to
        // read the portfolio could answer a question the document never asked.
        allowTools: false,
        ...(options.retriever ? { retriever: options.retriever } : {}),
        ...(options.client ? { client: options.client } : {}),
      });

      const gated = gateExtraction(run.redactor.restoreDeep(run.result), context);
      const signalsToStore = gated.extraction.proposedRiskSignals;

      // Signals still awaiting a decision are replaced by this extraction's, so a
      // forced re-read cannot leave two contradictory proposals for one page.
      // Decided signals are kept: they are a record of a human judgement.
      const superseded = await prisma.documentSignal.count({
        where: { documentId: row.id, organizationId: actor.organizationId, status: 'PROPOSED' },
      });

      await prisma.$transaction([
        prisma.documentSignal.deleteMany({
          where: { documentId: row.id, organizationId: actor.organizationId, status: 'PROPOSED' },
        }),
        prisma.document.update({
          where: { id: row.id },
          data: {
            processingStatus: 'EXTRACTED',
            documentType: gated.extraction.documentType,
            summary: gated.extraction.summary,
            extraction: json(gated.extraction),
            message:
              `Extracted ${gated.extraction.extractedFacts.length} fact(s) and ${signalsToStore.length} proposed signal(s) from ` +
              `${corpus.pages.length} page(s). Nothing was applied.`,
          },
        }),
        prisma.documentSignal.createMany({
          data: signalsToStore.map((signal) => ({
            id: newId(),
            documentId: row.id,
            organizationId: actor.organizationId,
            code: signal.code,
            title: signal.title,
            detail: signal.detail,
            severity: signal.severity,
            page: signal.page ?? null,
            supportingText: signal.supportingText,
            status: 'PROPOSED' as const,
          })),
        }),
      ]);

      await recordAudit({
        organizationId: actor.organizationId,
        actor,
        action: 'AI.DOCUMENT_EXTRACTED',
        entityType: 'Document',
        entityId: row.publicId,
        detail:
          `AI read '${toLogSafe(row.name)}' and proposed ${gated.extraction.extractedFacts.length} fact(s) and ${signalsToStore.length} signal(s)` +
          `${request.force ? `, replacing ${superseded} undecided signal(s)` : ''}. ` +
          `Withheld ${gated.droppedFacts} unverifiable fact(s), ${gated.droppedSignals} unsupported signal(s) and ${gated.droppedCitations} unquoted citation(s). ` +
          'All findings are proposals: no exception, stage or exposure was changed.',
        requestId: options.requestId ?? null,
      });

      return { ...run, result: gated.extraction };
    },
  );
}

// ---------------------------------------------------------------------------
// Signal review
// ---------------------------------------------------------------------------

/**
 * Records a person's decision about one proposed signal.
 *
 * This is the whole of what accepting a signal does. It writes the decision and
 * an audit event; it does not raise an exception, override a stage, or change an
 * exposure. Wiring a decision to a mutation would make a document the origin of
 * a financial number, which is the one thing this feature must not do — the
 * existing override and exception paths keep their own permissions and reviews.
 */
export async function decideSignal(
  actor: AuditActor,
  documentPublicId: string,
  signalId: string,
  request: SignalDecisionRequest,
): Promise<DocumentSignalRecord> {
  assertActorPermission(actor, 'document:write', 'review a proposed document signal');

  const document = await findDocument(actor.organizationId, documentPublicId);
  // Addressed by its own id *and* the document's, so a signal id from another
  // document is a 404 rather than a decision recorded against the wrong file.
  const signal = await prisma.documentSignal.findFirst({
    where: { id: signalId, documentId: document.id, organizationId: actor.organizationId },
  });
  if (!signal) throw notFound('No proposed signal matches that id on this document');
  if (signal.status !== 'PROPOSED') throw documentSignalAlreadyDecided(signal.status);

  const updated = await prisma.documentSignal.update({
    where: { id: signal.id },
    data: {
      status: request.decision,
      decidedById: actor.id,
      decidedBy: actor.fullName,
      decidedAt: new Date(),
      decisionNote: request.note,
    },
  });

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: request.decision === 'ACCEPTED' ? 'AI.SIGNAL_ACCEPTED' : 'AI.SIGNAL_REJECTED',
    entityType: 'DocumentSignal',
    entityId: signal.id,
    detail:
      `${request.decision === 'ACCEPTED' ? 'Accepted' : 'Rejected'} proposed signal '${toLogSafe(signal.title)}' (${signal.code}) ` +
      `from document '${toLogSafe(document.name)}'${signal.page ? ` page ${signal.page}` : ''}. Note: ${toLogSafe(request.note, 300)}. ` +
      'No exception, staging decision or exposure row was changed by this decision.',
  });

  return toSignalRecord(updated);
}
