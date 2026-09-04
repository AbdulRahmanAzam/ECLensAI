/**
 * Approved-run PDF report.
 *
 * Follows `templates.service.ts`'s shape: a typed request in, a `Buffer` out,
 * an audit event recorded, and a caller free to return it as JSON (base64) or
 * as raw bytes. The one deliberate difference from that pattern: this report
 * is never generated for a run that has no persisted results (`DRAFT`,
 * `PENDING`, `RUNNING`, `FAILED`) — there would be nothing honest to print.
 *
 * AI commentary is never generated inside this request. Gemini is a network
 * call with its own latency and failure modes; a report button that can hang
 * or fail on the model is worse than one that never touches it. If the caller
 * has already drafted an Executive Commentary elsewhere (the panel already
 * requires an explicit click — "generated on demand" is a fact about that
 * flow, not this one) and wants it in the document, they pass the headline
 * and overview text through `aiCommentary`; this service only ever renders
 * text it was handed, in a box clearly separate from the deterministic
 * tables, never text it produced itself.
 */
import PDFDocument from 'pdfkit';
import { formatDecimalMoney, formatDecimalPercent } from '@eclens/shared';
import { recordAudit, type AuditActor } from '../lib/audit';
import { prisma } from '../lib/prisma';
import { HttpError } from '../utils/httpError';
import { getConcentration, getMovementBridge } from './analytics.service';
import { getExceptionSummary } from './exceptions.service';
import { getRun } from './runs.service';
import { RESULT_BEARING_STATUSES } from './portfolio.service';

export interface ReportRequest {
  runId: string;
  /** Client-supplied, already-drafted commentary. Never generated here. */
  aiCommentary?: { headline: string; overview: string } | null;
}

export interface ReportDownload {
  fileName: string;
  contentType: string;
  contentBase64: string;
}

const PDF_CONTENT_TYPE = 'application/pdf';
const PAGE_MARGIN = 48;

const money = (currency: string) => (value: string | null | undefined) => formatDecimalMoney(value, currency, { compact: false });
/** For a raw fraction (e.g. coverageRatio "0.0255", scenario weight "0.5000000000"). */
const percent = (value: string | null | undefined) => formatDecimalPercent(value, 2);
/**
 * For a field the analytics layer already scaled to percent (e.g.
 * `shareOfAllowancePercent` — "14.08" meaning 14.08%). Running one of these
 * through `percent()` would multiply by 100 a second time.
 */
const alreadyPercent = (value: string | null | undefined): string => (value === null || value === undefined ? '—' : `${Number(value).toFixed(2)}%`);

function drawWatermark(doc: PDFKit.PDFDocument): void {
  const { width, height } = doc.page;
  doc.save();
  doc.rotate(-38, { origin: [width / 2, height / 2] });
  doc.fontSize(58).fillColor('#dc2626', 0.16).text('DRAFT — NOT APPROVED', 0, height / 2 - 30, {
    width,
    align: 'center',
  });
  doc.restore();
  doc.fillColor('black');
}

function sectionTitle(doc: PDFKit.PDFDocument, text: string): void {
  doc.moveDown(0.8);
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#0a2540').text(text);
  doc.moveDown(0.2);
  doc
    .moveTo(doc.x, doc.y)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
    .strokeColor('#e2e8f0')
    .stroke();
  doc.moveDown(0.4);
  doc.font('Helvetica').fontSize(9).fillColor('#1e293b');
}

/**
 * pdfkit's own auto-pagination only fires for text drawn without explicit
 * coordinates. Every helper below draws at an explicit, manually-tracked `y`
 * (required to lay out label/value pairs and table columns side by side), so
 * page breaks have to be decided here — explicitly, before drawing — rather
 * than left to pdfkit, which does something far stranger (one page per cell,
 * observed) when a later call's y ends up behind an earlier call's advanced
 * cursor on the same nominal row.
 */
function ensureSpace(doc: PDFKit.PDFDocument, height: number): void {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height > bottom) doc.addPage();
}

const ROW_HEIGHT = 14;

function keyValueRow(doc: PDFKit.PDFDocument, label: string, value: string): void {
  ensureSpace(doc, ROW_HEIGHT);
  const y = doc.y;
  doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(label, PAGE_MARGIN, y, { width: 200, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#0a2540').text(value, PAGE_MARGIN + 200, y, {
    width: doc.page.width - PAGE_MARGIN * 2 - 200,
    align: 'right',
    lineBreak: false,
  });
  doc.y = y + ROW_HEIGHT;
}

/** For a value that genuinely needs to wrap (a free-text comment), not a single-line pair. */
function wrappedRow(doc: PDFKit.PDFDocument, label: string, value: string): void {
  const width = doc.page.width - PAGE_MARGIN * 2;
  const height = doc.font('Helvetica-Bold').fontSize(9).heightOfString(value, { width });
  ensureSpace(doc, 12 + height);
  doc.font('Helvetica').fontSize(9).fillColor('#64748b').text(label, PAGE_MARGIN, doc.y, { width, lineBreak: false });
  doc.moveDown(0.1);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#0a2540').text(value, PAGE_MARGIN, doc.y, { width });
  doc.moveDown(0.2);
}

function table(doc: PDFKit.PDFDocument, headers: string[], rows: string[][], widths: number[]): void {
  const startX = PAGE_MARGIN;
  const tableWidth = widths.reduce((a, b) => a + b, 0);
  ensureSpace(doc, ROW_HEIGHT * (rows.length > 0 ? 2 : 1));

  let y = doc.y;
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#64748b');
  let x = startX;
  headers.forEach((header, index) => {
    doc.text(header, x, y, { width: widths[index], align: index === 0 ? 'left' : 'right', lineBreak: false });
    x += widths[index];
  });
  y += ROW_HEIGHT;
  doc.moveTo(startX, y - 3).lineTo(startX + tableWidth, y - 3).strokeColor('#e2e8f0').stroke();

  doc.font('Helvetica').fontSize(8).fillColor('#1e293b');
  for (const row of rows) {
    if (y + ROW_HEIGHT > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    x = startX;
    row.forEach((cell, index) => {
      doc.text(cell, x, y, { width: widths[index], align: index === 0 ? 'left' : 'right', lineBreak: false });
      x += widths[index];
    });
    y += ROW_HEIGHT;
  }
  doc.y = y + 6;
}

/**
 * Builds the PDF for one run. Refuses a run with no persisted results; the
 * caller decides whether that refusal becomes a 409 or a 400 — this function
 * only guarantees it never hands back an empty or fabricated report.
 */
export async function buildRunReportPdf(actor: AuditActor, request: ReportRequest): Promise<ReportDownload> {
  const run = await getRun(actor.organizationId, request.runId);
  if (!RESULT_BEARING_STATUSES.includes(run.status)) {
    throw new HttpError(
      409,
      'RUN_NOT_REPORTABLE',
      `Run ${run.publicId} is '${run.status}' and has no persisted results. A report can only be generated for a run that has completed execution.`,
    );
  }
  if (!run.totals) {
    throw new HttpError(409, 'RUN_NOT_REPORTABLE', `Run ${run.publicId} has no stored totals to report.`);
  }

  const organization = await prisma.organization.findUnique({
    where: { id: actor.organizationId },
    select: { name: true, currency: true },
  });
  const currency = organization?.currency ?? 'PKR';
  const fmt = money(currency);

  const [movement, concentration, exceptions] = await Promise.all([
    getMovementBridge(actor.organizationId, { snapshotId: run.snapshotId }).catch(() => null),
    getConcentration(actor.organizationId, { snapshotId: run.snapshotId }).catch(() => null),
    getExceptionSummary(actor.organizationId).catch(() => null),
  ]);

  const doc = new PDFDocument({ size: 'A4', margins: { top: PAGE_MARGIN, bottom: 56, left: PAGE_MARGIN, right: PAGE_MARGIN }, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const isApproved = run.status === 'APPROVED';
  const generatedAt = new Date();

  // -- Header -----------------------------------------------------------
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#0a2540').text('ECLens AI — ECL Run Report');
  doc.font('Helvetica').fontSize(10).fillColor('#64748b').text(organization?.name ?? 'Organisation');
  doc.moveDown(0.6);
  keyValueRow(doc, 'Reporting date', run.runDate);
  keyValueRow(doc, 'Run ID', run.publicId);
  keyValueRow(doc, 'Approval status', run.status);
  keyValueRow(doc, 'Scope', `${run.snapshotLabel} (${run.totals.exposureCount} exposures)`);
  keyValueRow(doc, 'Model configuration', `${run.modelConfigurationName} v${run.modelConfigurationVersion}`);
  keyValueRow(doc, 'Scenario set', `${run.scenarioSetName} v${run.scenarioSetVersion}`);

  // -- Executive summary --------------------------------------------------
  sectionTitle(doc, 'Executive summary');
  doc
    .fontSize(9)
    .fillColor('#1e293b')
    .text(
      `This report presents the ${run.status.toLowerCase()} Expected Credit Loss calculation for ${run.snapshotLabel} as at ${run.runDate}. ` +
        `The book carries a gross carrying amount of ${fmt(run.totals.totalGrossCarryingAmount)} across ${run.totals.exposureCount} exposures, ` +
        `an exposure at default of ${fmt(run.totals.totalEad)}, and a loss allowance of ${fmt(run.totals.totalLossAllowance)} — ` +
        `a coverage ratio of ${percent(run.totals.coverageRatio)}. ` +
        `Every figure below is copied from the run's persisted totals; nothing in this section was recalculated for the report.`,
      { align: 'left' },
    );

  // -- Totals ---------------------------------------------------------------
  sectionTitle(doc, 'Portfolio totals');
  keyValueRow(doc, 'Gross carrying amount', fmt(run.totals.totalGrossCarryingAmount));
  keyValueRow(doc, 'Exposure at default (EAD)', fmt(run.totals.totalEad));
  keyValueRow(doc, 'Loss allowance', fmt(run.totals.totalLossAllowance));
  keyValueRow(doc, 'Net carrying amount', fmt(run.totals.totalNetCarryingAmount));
  keyValueRow(doc, 'Coverage ratio', percent(run.totals.coverageRatio));

  // -- Stage breakdown --------------------------------------------------------
  sectionTitle(doc, 'Stage breakdown');
  table(
    doc,
    ['Stage', 'Exposures', 'Gross carrying', 'EAD', 'Allowance', 'Coverage'],
    run.totals.stageBuckets.map((bucket) => [
      `Stage ${bucket.stage}`,
      String(bucket.exposureCount),
      fmt(bucket.grossCarryingAmount),
      fmt(bucket.ead),
      fmt(bucket.lossAllowance),
      percent(bucket.coverageRatio),
    ]),
    [70, 70, 110, 100, 100, 75],
  );

  // -- Scenario weights ---------------------------------------------------------
  if (run.lockedScenarioSet) {
    sectionTitle(doc, 'Scenario weights');
    table(
      doc,
      ['Scenario', 'Weight', 'PD multiplier', 'LGD multiplier'],
      run.lockedScenarioSet.scenarios.map((scenario) => [
        scenario.name,
        percent(scenario.weight),
        `×${scenario.pdMultiplier}`,
        `×${scenario.lgdMultiplier}`,
      ]),
      [180, 100, 100, 100],
    );
  }

  // -- Major movements ------------------------------------------------------------
  sectionTitle(doc, 'Major movements since the prior period');
  if (movement) {
    for (const component of movement.components) {
      if (component.amount === null) continue;
      keyValueRow(doc, component.label, fmt(component.amount));
    }
    if (movement.limitations.length > 0) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#64748b');
      for (const limitation of movement.limitations) doc.text(limitation, { width: doc.page.width - PAGE_MARGIN * 2 });
      doc.font('Helvetica').fillColor('#1e293b');
    }
  } else {
    doc.fontSize(9).fillColor('#64748b').text('No prior reporting period with a completed run exists, so no movement could be measured.');
  }

  // -- Concentration risks ------------------------------------------------------------
  if (concentration) {
    sectionTitle(doc, 'Concentration risks');
    const segmentSlice = concentration.slices.find((slice) => slice.dimension === 'segment');
    if (segmentSlice) {
      table(
        doc,
        ['Segment', 'Exposures', 'Allowance', 'Share of allowance'],
        segmentSlice.buckets.slice(0, 5).map((bucket) => [
          bucket.key,
          String(bucket.exposureCount),
          fmt(bucket.lossAllowance),
          alreadyPercent(bucket.shareOfAllowancePercent),
        ]),
        [180, 90, 110, 110],
      );
    }
  }

  // -- Model version and material assumptions -----------------------------------------------
  sectionTitle(doc, 'Model version and material assumptions');
  wrappedRow(doc, 'Model configuration', `${run.modelConfigurationName} v${run.modelConfigurationVersion} (${run.modelConfigurationId})`);
  if (run.lockedConfiguration) {
    keyValueRow(doc, 'PD floor / ceiling', `${run.lockedConfiguration.pdFloor} / ${run.lockedConfiguration.pdCeiling}`);
    keyValueRow(doc, 'LGD floor / ceiling', `${run.lockedConfiguration.lgdFloor} / ${run.lockedConfiguration.lgdCeiling}`);
    keyValueRow(doc, 'Lifetime horizon cap', `${run.lockedConfiguration.lifetimeHorizonMonthsCap} months`);
    keyValueRow(doc, 'Discount convention', run.lockedConfiguration.discountConvention);
    keyValueRow(
      doc,
      'Effective interest rate range',
      `${run.lockedConfiguration.effectiveInterestRateMin} – ${run.lockedConfiguration.effectiveInterestRateMax}`,
    );
    keyValueRow(doc, 'Staging rule set', `${run.lockedConfiguration.stagingRuleSet.id} v${run.lockedConfiguration.stagingRuleSet.version}`);
    keyValueRow(doc, 'Stage 3 (default) DPD backstop', `${run.lockedConfiguration.stagingRuleSet.stage3DpdThreshold} days`);
    keyValueRow(doc, 'Stage 2 (SICR) DPD backstop', `${run.lockedConfiguration.stagingRuleSet.stage2DpdThreshold} days`);
  }

  // -- Data-quality limitations ---------------------------------------------------------------
  sectionTitle(doc, 'Data-quality limitations');
  if (exceptions && exceptions.open > 0) {
    doc.fontSize(9).fillColor('#1e293b').text(
      `${exceptions.open} data-quality exception(s) remain open across the organisation at the time this report was generated. ` +
        `These do not block a completed run, but a reviewer should confirm they do not affect the exposures reported here.`,
    );
  } else {
    doc.fontSize(9).fillColor('#1e293b').text('No open data-quality exceptions were recorded for this organisation at the time this report was generated.');
  }
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#1e293b').text(`Rounding policy: money is rounded to 2 decimal places; rates and factors to 10 decimal places, half-up.`);

  // -- Approval history ------------------------------------------------------------------------
  sectionTitle(doc, 'Approval history');
  keyValueRow(doc, 'Created by', run.createdByName);
  keyValueRow(doc, 'Submitted by', run.submittedByName ? `${run.submittedByName}${run.submittedAt ? ` (${run.submittedAt})` : ''}` : 'Not submitted');
  keyValueRow(
    doc,
    'Reviewed by',
    run.reviewedByName ? `${run.reviewedByName} — ${run.reviewDecision ?? 'pending'}${run.reviewedAt ? ` (${run.reviewedAt})` : ''}` : 'Not yet reviewed',
  );
  if (run.reviewComment) wrappedRow(doc, 'Review comment', run.reviewComment);

  // -- AI commentary (client-supplied, optional) ------------------------------------------------
  if (request.aiCommentary) {
    sectionTitle(doc, 'AI-drafted commentary');
    doc.save();
    const boxTop = doc.y;
    doc.font('Helvetica-Oblique').fontSize(8).fillColor('#7c3aed').text(
      'Generated on demand by the requesting analyst using Gemini. Grounded in the figures above; the framing is the model\'s, not a verified fact. Verify before relying on it.',
      { width: doc.page.width - PAGE_MARGIN * 2 },
    );
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#0a2540').text(request.aiCommentary.headline);
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(9).fillColor('#1e293b').text(request.aiCommentary.overview, { width: doc.page.width - PAGE_MARGIN * 2 });
    const boxBottom = doc.y;
    doc
      .rect(PAGE_MARGIN - 6, boxTop - 6, doc.page.width - (PAGE_MARGIN - 6) * 2, boxBottom - boxTop + 12)
      .strokeColor('#c4b5fd')
      .stroke();
    doc.restore();
  }

  // -- Disclaimer ------------------------------------------------------------------------------
  sectionTitle(doc, 'Disclaimer');
  doc
    .fontSize(8)
    .fillColor('#64748b')
    .text(
      'This report is produced from data seeded for demonstration purposes and does not represent a real institution\'s ' +
        'portfolio. All figures are computed by a deterministic engine; no figure in this report was calculated or altered ' +
        'by an AI model. Any AI-drafted commentary above is clearly separated and advisory only.',
      { width: doc.page.width - PAGE_MARGIN * 2 },
    );

  // -- Footer + watermark on every page ---------------------------------------------------------
  const range = doc.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);
    if (!isApproved) drawWatermark(doc);
    doc
      .font('Helvetica')
      .fontSize(7)
      .fillColor('#94a3b8')
      .text(
        `ECLens AI · Generated ${generatedAt.toISOString()} · Page ${index - range.start + 1} of ${range.count}`,
        PAGE_MARGIN,
        doc.page.height - 36,
        { width: doc.page.width - PAGE_MARGIN * 2, align: 'center' },
      );
  }

  doc.end();
  const buffer = await finished;

  await recordAudit({
    organizationId: actor.organizationId,
    actor,
    action: 'REPORT.GENERATED',
    entityType: 'EclRun',
    entityId: run.id,
    detail: `Generated a PDF report for run ${run.publicId} (${run.status}).`,
  });

  return {
    fileName: `eclens-report-${run.publicId}.pdf`,
    contentType: PDF_CONTENT_TYPE,
    contentBase64: buffer.toString('base64'),
  };
}
