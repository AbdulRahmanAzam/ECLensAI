/**
 * Governance knowledge retrieval.
 *
 * The provider is an interface on purpose. Two implementations ship: a lexical
 * BM25 ranker that needs nothing but PostgreSQL, and a Gemini-embedding ranker.
 * Neither uses pgvector — the local `postgres:16-alpine` image does not carry
 * the extension, and adding a `tsvector` generated column or an expression
 * index behind Prisma's back would put the schema permanently out of step with
 * the migrations. Both implementations are therefore application-side over a
 * SQL-prefiltered candidate set, which also makes them fully testable offline.
 *
 * The honest cost of that choice is a scale ceiling, and it is documented at
 * each constant below rather than hidden: this is a per-institution policy
 * library of tens to low hundreds of documents, not a web-scale corpus.
 */
import { createHash } from 'node:crypto';
import { Prisma, type DocumentCategory } from '@prisma/client';
import { env } from '../../config/env';
import { newId } from '../../lib/ids';
import { logger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { chunkDocumentPages, estimateTokens } from './chunking';
import { geminiClient, type GeminiClient } from './geminiClient';
import type { DocumentChunkRecord } from '@eclens/shared';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface RetrievedChunk {
  documentPublicId: string;
  documentName: string;
  category: string;
  page: number | null;
  chunkOrdinal: number;
  heading: string | null;
  text: string;
  score: number;
  seeded: boolean;
  sourceUrl: string | null;
}

export interface RetrievalQuery {
  organizationId: string;
  query: string;
  topK?: number;
  categories?: string[];
  documentPublicIds?: string[];
}

export interface KnowledgeRetriever {
  readonly name: string;
  search(query: RetrievalQuery): Promise<RetrievedChunk[]>;
  /** Persists vectors for the embedding provider; a no-op for the lexical one. */
  indexChunks(organizationId: string, documentId: string, chunks: DocumentChunkRecord[]): Promise<void>;
}

/**
 * Long enough that a policy library is fully scanned at demo scale, short
 * enough that a misconfigured corpus cannot pull the whole table into memory.
 */
const EMBEDDING_SCAN_LIMIT = 2_000;
/** Rows the lexical prefilter may return before scoring. */
const BM25_CANDIDATE_LIMIT = 400;
const MAX_QUERY_TOKENS = 8;
const DEFAULT_TOP_K = 6;

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'that', 'this', 'from', 'has', 'have', 'had',
  'not', 'but', 'what', 'when', 'which', 'who', 'how', 'why', 'does', 'did', 'can', 'could',
  'should', 'would', 'will', 'about', 'into', 'over', 'than', 'then', 'there', 'their', 'they',
  'our', 'your', 'all', 'any', 'been', 'being', 'between', 'each', 'such', 'only', 'also',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

/** Bounded, de-duplicated query terms. More terms means more count queries. */
export function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  for (const token of tokenize(query)) {
    seen.add(token);
    if (seen.size >= MAX_QUERY_TOKENS) break;
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Shared candidate loading
// ---------------------------------------------------------------------------

interface ChunkRow {
  id: string;
  ordinal: number;
  page: number | null;
  heading: string | null;
  text: string;
  tokenEstimate: number;
  embedding: unknown;
  document: { publicId: string; name: string; category: string; seeded: boolean; sourceUrl: string | null };
}

const CHUNK_SELECT = {
  id: true,
  ordinal: true,
  page: true,
  heading: true,
  text: true,
  tokenEstimate: true,
  embedding: true,
  document: { select: { publicId: true, name: true, category: true, seeded: true, sourceUrl: true } },
} as const;

function scopeWhere(query: RetrievalQuery): Prisma.DocumentChunkWhereInput {
  return {
    organizationId: query.organizationId,
    // A document that failed to parse or is of an unsupported type has no
    // trustworthy text, so it is never retrievable.
    document: {
      processingStatus: { in: ['INDEXED', 'EXTRACTED'] },
      ...(query.categories?.length ? { category: { in: query.categories as DocumentCategory[] } } : {}),
      ...(query.documentPublicIds?.length ? { publicId: { in: query.documentPublicIds } } : {}),
    },
  };
}

function toRetrievedChunk(row: ChunkRow, score: number): RetrievedChunk {
  return {
    documentPublicId: row.document.publicId,
    documentName: row.document.name,
    category: row.document.category,
    page: row.page,
    chunkOrdinal: row.ordinal,
    heading: row.heading,
    text: row.text,
    score,
    seeded: row.document.seeded,
    sourceUrl: row.document.sourceUrl,
  };
}

// ---------------------------------------------------------------------------
// BM25 provider (default)
// ---------------------------------------------------------------------------

const BM25_K1 = 1.2;
const BM25_B = 0.75;

export class Bm25Retriever implements KnowledgeRetriever {
  readonly name = 'bm25';

  async indexChunks(): Promise<void> {
    // Lexical retrieval reads the stored text directly; nothing to precompute.
  }

  async search(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    const tokens = queryTokens(query.query);
    if (tokens.length === 0) return [];

    const topK = query.topK ?? DEFAULT_TOP_K;
    const where = scopeWhere(query);

    const [stats, candidates, documentFrequencies] = await Promise.all([
      prisma.documentChunk.aggregate({
        where: { organizationId: query.organizationId },
        _count: { _all: true },
        _avg: { tokenEstimate: true },
      }),
      prisma.documentChunk.findMany({
        where: { ...where, OR: tokens.map((token) => ({ text: { contains: token } })) },
        select: CHUNK_SELECT,
        take: BM25_CANDIDATE_LIMIT,
        orderBy: { id: 'asc' },
      }),
      Promise.all(
        tokens.map(async (token) =>
          prisma.documentChunk.count({
            where: { organizationId: query.organizationId, text: { contains: token } },
          }),
        ),
      ),
    ]);

    if (candidates.length === 0) return [];

    const corpusSize = Math.max(1, stats._count._all);
    const averageLength = Math.max(1, stats._avg.tokenEstimate ?? 1);
    const df = new Map(tokens.map((token, index) => [token, documentFrequencies[index] ?? 0]));

    const scored = candidates.map((row) => {
      const words = tokenize(row.text);
      const length = Math.max(1, words.length || row.tokenEstimate);
      const counts = new Map<string, number>();
      for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);

      let score = 0;
      for (const token of tokens) {
        const termFrequency = counts.get(token) ?? 0;
        if (termFrequency === 0) continue;
        const frequency = df.get(token) ?? 0;
        const idf = Math.log(1 + (corpusSize - frequency + 0.5) / (frequency + 0.5));
        const denominator = termFrequency + BM25_K1 * (1 - BM25_B + (BM25_B * length) / averageLength);
        score += idf * ((termFrequency * (BM25_K1 + 1)) / denominator);
      }

      // A heading match is worth more than a body match: policy headings are
      // where a threshold is named, and the body merely restates it.
      if (row.heading && tokens.some((token) => row.heading?.toLowerCase().includes(token))) score *= 1.25;

      return { row: row as ChunkRow, score };
    });

    return scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((entry) => toRetrievedChunk(entry.row, Number(entry.score.toFixed(4))));
  }
}

// ---------------------------------------------------------------------------
// Embedding provider
// ---------------------------------------------------------------------------

function asVector(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const vector = value.filter((component): component is number => typeof component === 'number');
  return vector.length === value.length && vector.length > 0 ? vector : null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const EMBEDDING_BATCH = 16;

export class EmbeddingRetriever implements KnowledgeRetriever {
  readonly name = 'embedding';

  constructor(private readonly client: GeminiClient) {}

  async indexChunks(organizationId: string, documentId: string, chunks: DocumentChunkRecord[]): Promise<void> {
    if (chunks.length === 0) return;

    for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH) {
      const batch = chunks.slice(start, start + EMBEDDING_BATCH);
      let vectors: number[][];
      try {
        vectors = await this.client.embed({
          model: env.GEMINI_EMBEDDING_MODEL,
          texts: batch.map((chunk) => chunk.text),
          timeoutMs: env.AI_TIMEOUT_MS,
        });
      } catch (error) {
        // Chunks stay searchable by the lexical fallback path and the document
        // still has its text; a failed embedding call must not lose the upload.
        logger.warn(
          { organizationId, documentId, reason: (error as Error)?.message },
          'Embedding batch failed; chunks remain indexed without vectors',
        );
        return;
      }

      await prisma.$transaction(
        batch.map((chunk, index) =>
          prisma.documentChunk.updateMany({
            where: { documentId, ordinal: chunk.ordinal, organizationId },
            data: {
              embedding: vectors[index] as unknown as object,
              embeddingModel: env.GEMINI_EMBEDDING_MODEL,
            },
          }),
        ),
      );
    }
  }

  async search(query: RetrievalQuery): Promise<RetrievedChunk[]> {
    const text = query.query.trim();
    if (text.length === 0) return [];

    const [vector] = await this.client.embed({
      model: env.GEMINI_EMBEDDING_MODEL,
      texts: [text],
      timeoutMs: env.AI_TIMEOUT_MS,
    });
    if (!vector) return [];

    const rows = await prisma.documentChunk.findMany({
      where: { ...scopeWhere(query), embedding: { not: Prisma.DbNull } },
      select: CHUNK_SELECT,
      take: EMBEDDING_SCAN_LIMIT,
      orderBy: { id: 'asc' },
    });

    return rows
      .map((row) => ({ row, score: cosineSimilarity(vector, asVector(row.embedding) ?? []) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.topK ?? DEFAULT_TOP_K)
      .map((entry) => toRetrievedChunk(entry.row, Number(entry.score.toFixed(4))));
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function createRetriever(client: GeminiClient): KnowledgeRetriever {
  if (env.GEMINI_RETRIEVAL_PROVIDER === 'embedding' && client.configured) {
    return new EmbeddingRetriever(client);
  }
  if (env.GEMINI_RETRIEVAL_PROVIDER === 'embedding') {
    logger.warn('GEMINI_RETRIEVAL_PROVIDER=embedding but no Gemini client is configured; falling back to bm25');
  }
  return new Bm25Retriever();
}

let ambientRetriever: KnowledgeRetriever | null = null;

export function knowledgeRetriever(client: GeminiClient): KnowledgeRetriever {
  if (!ambientRetriever) ambientRetriever = createRetriever(client);
  return ambientRetriever;
}

export function setKnowledgeRetriever(retriever: KnowledgeRetriever | null): void {
  ambientRetriever = retriever;
}

// ---------------------------------------------------------------------------
// Seeded governance knowledge
// ---------------------------------------------------------------------------

interface SeedEntry {
  heading: string;
  body: string;
}

/**
 * Concise, paraphrased orientation notes with precise paragraph citations.
 *
 * This is deliberately *not* the text of IFRS 9. The standard is copyrighted and
 * bundling it — even in part — would put a licence obligation into every
 * deployment. What ships is a short map: which paragraphs cover which topic, so
 * the assistant can point an analyst at the right clause and say what the
 * institution's own policy would need to address. Licensed material is meant to
 * be uploaded by the institution, which is what the document pipeline is for.
 */
const GOVERNANCE_SEED: SeedEntry[] = [
  {
    heading: 'Scope of the ECL model',
    body:
      'IFRS 9 requires an expected credit loss allowance on financial assets measured at amortised cost and on loan commitments and financial guarantee contracts. The requirement is forward-looking: an allowance is recognised from initial recognition, not only once a loss event has occurred. Paragraphs 5.5.1 to 5.5.20 set out the general model; paragraph 5.5.5 states the three-part objective of recognising lifetime expected credit losses when credit risk has increased significantly since initial recognition.',
  },
  {
    heading: 'Significant increase in credit risk (SICR)',
    body:
      'Paragraph 5.5.9 requires an entity to assess at each reporting date whether credit risk has increased significantly since initial recognition. Paragraph 5.5.11 requires the assessment to compare the risk of default over the expected life at the reporting date with the risk at initial recognition, and permits the use of changes in the twelve-month risk as a reasonable approximation when lifetime measurement is impracticable. Paragraph B5.5.17 lists qualitative and quantitative indicators, and paragraph 5.5.11 makes clear that a change in internal credit rating is not by itself determinative.',
  },
  {
    heading: 'The rebuttable 30 days past due presumption',
    body:
      'Paragraph 5.5.11 states that credit risk is presumed to have increased significantly when contractual payments are more than 30 days past due. The presumption is rebuttable, but paragraph B5.5.19 requires an entity that rebuts it to have reasonable and supportable information available without undue cost or effort, and to document that justification. An institution whose staging rule set rebuts the presumption should hold the supporting analysis in its policy documentation.',
  },
  {
    heading: 'Definition of default and credit-impaired assets',
    body:
      'Paragraph 5.5.37 requires a single, consistently applied definition of default across the entity. Paragraph B5.5.37 notes that 90 days past due is the customary outer limit and that a longer limit requires justification. Stage 3 assets are those that are credit-impaired; Appendix A defines a credit-impaired financial asset as one where one or more events with a detrimental impact on estimated future cash flows have occurred.',
  },
  {
    heading: 'Measurement: twelve-month versus lifetime expected credit losses',
    body:
      'Paragraph 5.5.5 requires a twelve-month allowance for stage 1 and a lifetime allowance for stages 2 and 3. Paragraph 5.5.13 requires the measurement to reflect an unbiased and probability-weighted amount determined by evaluating a range of possible outcomes, the time value of money, and reasonable and supportable information about past events, current conditions and forecasts of future economic conditions.',
  },
  {
    heading: 'Probability-weighted scenarios and forward-looking information',
    body:
      'Paragraph B5.5.41 requires at least a consideration of multiple economic scenarios where the effect is material, and states that the scenarios need not be exhaustive. Paragraph B5.5.42 discusses weighting, and paragraph B5.5.44 requires the entity to consider the availability of reasonable and supportable forward-looking information at the reporting date. A scenario set with a single scenario should be justified in policy rather than adopted by default.',
  },
  {
    heading: 'Discounting and the effective interest rate',
    body:
      'Paragraph 5.5.17 requires expected credit losses to be discounted at the effective interest rate determined at initial recognition or an approximation of it, or, for purchased or originated credit-impaired assets, at the credit-adjusted effective interest rate. Discounting is not optional and the rate used must be documented in the model configuration.',
  },
  {
    heading: 'Exposure at default and prepayment behaviour',
    body:
      'Paragraph B5.5.31 requires the estimate of exposure at default to reflect expected changes in the balance over the remaining life, including repayments of principal and interest and drawdowns of undrawn commitments. Paragraph B5.5.32 requires a credit conversion factor to be estimated for undrawn commitments where a present commitment to extend credit exists and cannot be unconditionally cancelled.',
  },
  {
    heading: 'Loss given default and collateral',
    body:
      'Paragraph B5.5.55 requires loss given default estimates to reflect the entity\'s own loss experience and to account for collateral and other credit enhancements, valued on a realistic basis rather than at an optimistic forced-sale price. Where collateral values are stale or unindexed, that limitation belongs in the policy and in the reporting, not buried in a parameter.',
  },
  {
    heading: 'Grouping and individual assessment',
    body:
      'Paragraph B5.5.1 requires expected credit losses to be measured either on an individual instrument basis or on a collective basis using groupings that share credit risk characteristics. Paragraph B5.5.2 warns against grouping instruments in a way that obscures a significant increase in risk for a subgroup. Segment definitions in the portfolio data should map to the groupings the policy describes.',
  },
  {
    heading: 'Modifications, forbearance and restructuring',
    body:
      'Paragraph 5.5.20 requires an entity that modifies contractual cash flows to consider whether the modification results in derecognition, and paragraph B5.5.26 notes that a modification undertaken for reasons relating to the borrower\'s credit risk is itself an indicator of a significant increase in credit risk. Forbearance and restructuring flags in the exposure data should feed the staging assessment.',
  },
  {
    heading: 'Documentation, governance and model risk',
    body:
      'Paragraph 5.5.1 requires the estimates to be reasonable and supportable, which in practice means a documented model with versioned assumptions, an owner, a review cycle and an audit trail of who changed what. Where an analyst overrides a model-driven stage, the override, its reason and an independent review of it are the evidence that the judgement was governed rather than convenient.',
  },
];

const SEED_DOCUMENT_NAME = 'ECLens governance orientation notes';

export function seedSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Idempotent: the seed is identified by a content hash, so re-running it after
 * an upgrade refreshes the text without creating a duplicate library entry.
 */
export async function seedGovernanceKnowledge(organizationId: string, uploadedBy: string): Promise<string | null> {
  const body = GOVERNANCE_SEED.map((entry) => `${entry.heading}\n\n${entry.body}`).join('\n\n');
  const sha256 = seedSha256(body);

  const existing = await prisma.document.findFirst({
    where: { organizationId, seeded: true },
    select: { id: true, sha256: true },
  });
  if (existing && existing.sha256 === sha256) return null;

  const pages = GOVERNANCE_SEED.map((entry, index) => ({
    num: index + 1,
    text: `${entry.heading}\n\n${entry.body}`,
  }));
  const chunks = chunkDocumentPages(pages);

  if (existing) {
    await prisma.documentChunk.deleteMany({ where: { documentId: existing.id } });
    await prisma.document.update({
      where: { id: existing.id },
      data: { sha256, chunkCount: chunks.length, sizeBytes: Buffer.byteLength(body, 'utf8'), processingStatus: 'INDEXED' },
    });
    await indexDocumentChunks(organizationId, existing.id, chunks);
    return existing.id;
  }

  const id = newId();
  await prisma.document.create({
    data: {
      id,
      organizationId,
      publicId: `doc-seed-${id.slice(-8).toUpperCase()}`,
      name: SEED_DOCUMENT_NAME,
      category: 'GUIDANCE',
      mimeType: 'text/plain',
      sizeBytes: Buffer.byteLength(body, 'utf8'),
      sha256,
      pageCount: pages.length,
      chunkCount: chunks.length,
      processingStatus: 'INDEXED',
      documentType: 'GOVERNANCE_ORIENTATION',
      summary:
        'Concise orientation notes mapping IFRS 9 credit-loss topics to the paragraphs that govern them. Paraphrased summary only — the standard itself is copyrighted and is not bundled. Upload your institution’s licensed policy material for grounded answers against your own text.',
      seeded: true,
      uploadedBy,
    },
  });
  await indexDocumentChunks(organizationId, id, chunks);
  return id;
}

/**
 * The one way document text becomes retrievable.
 *
 * Rows are written first and provider-specific indexing second, because the
 * embedding provider *updates* chunk rows it does not create: vectorize first
 * and there is nothing to update. The default lexical provider precomputes
 * nothing, so for it the second step is a no-op and the text is searchable the
 * moment the rows exist.
 */
export async function indexDocumentChunks(
  organizationId: string,
  documentId: string,
  chunks: DocumentChunkRecord[],
  retriever?: KnowledgeRetriever,
): Promise<void> {
  if (chunks.length === 0) return;
  await insertChunks(organizationId, documentId, chunks);
  const active = retriever ?? knowledgeRetriever(geminiClient());
  await active.indexChunks(organizationId, documentId, chunks);
}

async function insertChunks(organizationId: string, documentId: string, chunks: DocumentChunkRecord[]): Promise<void> {
  if (chunks.length === 0) return;
  await prisma.documentChunk.createMany({
    data: chunks.map((chunk) => ({
      id: newId(),
      documentId,
      organizationId,
      ordinal: chunk.ordinal,
      page: chunk.page,
      heading: chunk.heading,
      text: chunk.text,
      tokenEstimate: chunk.tokenEstimate,
    })),
  });
}

/** Rendered evidence block for one retrieved chunk, with its citation locator. */
export function renderChunkAsEvidence(chunk: RetrievedChunk): string {
  const location = chunk.page ? `page ${chunk.page}` : `chunk ${chunk.chunkOrdinal}`;
  const heading = chunk.heading ? ` — ${chunk.heading}` : '';
  return `[DOCUMENT ${chunk.documentPublicId}, ${chunk.documentName}, ${location}${heading}]\n${chunk.text}`;
}

export { estimateTokens };
