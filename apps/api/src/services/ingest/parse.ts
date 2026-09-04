/**
 * Streaming, bounded-memory parsers for uploaded portfolio files.
 *
 * Both parsers emit the shared `RawTable` shape: headers plus rows of raw cell
 * TEXT. Nothing here interprets a value — no number parsing, no date parsing,
 * no percentage guessing. Interpretation happens later in the shared
 * validation module, where an ambiguous value becomes a quarantine issue
 * instead of being silently repaired.
 *
 * Memory is bounded twice over: rows are capped at `maxRows` (excess rows are
 * counted and the table flagged `truncated`), and cell text is capped per cell
 * so one pathological value cannot blow the heap.
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parse as parseCsv } from 'csv-parse';
import ExcelJS from 'exceljs';
import type { RawRow, RawTable } from '@eclens/shared';

/** A single cell larger than this is almost certainly a malformed file. */
const MAX_CELL_CHARS = 4_000;

/** Bytes inspected when sniffing the delimiter from the first line. */
const SNIFF_BYTES = 8_192;

export interface ParseOptions {
  maxRows: number;
}

function clipCell(value: string): string {
  return value.length > MAX_CELL_CHARS ? value.slice(0, MAX_CELL_CHARS) : value;
}

/**
 * Bank exports are variously comma, semicolon or tab delimited. Pick whichever
 * candidate appears most often on the first non-empty line, so a semicolon file
 * does not arrive as one giant single-column header.
 */
export async function sniffDelimiter(filePath: string): Promise<string> {
  const head = await readFile(filePath, { encoding: 'utf8', flag: 'r' }).catch(() => '');
  const sample = head.slice(0, SNIFF_BYTES);
  const firstLine = sample.split(/\r?\n/).find((line) => line.trim().length > 0) ?? '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export async function parseCsvFile(
  filePath: string,
  fileName: string,
  options: ParseOptions,
): Promise<RawTable> {
  const delimiter = await sniffDelimiter(filePath);
  const rows: RawRow[] = [];
  let headers: string[] = [];
  let skipped = 0;
  let sheetRow = 0;
  let headerSeen = false;

  await new Promise<void>((resolve, reject) => {
    createReadStream(filePath, { encoding: 'utf8' })
      .pipe(
        parseCsv({
          delimiter,
          bom: true,
          relax_column_count: true,
          relax_quotes: true,
          skip_empty_lines: true,
        }),
      )
      .on('data', (record: string[]) => {
        sheetRow += 1;
        if (!headerSeen) {
          headerSeen = true;
          headers = record.map((cell) => clipCell(String(cell ?? '')).trim());
          return;
        }
        if (rows.length >= options.maxRows) {
          skipped += 1;
          return;
        }
        rows.push({
          rowNumber: rows.length + 1,
          sheetRow,
          cells: record.map((cell) => clipCell(String(cell ?? ''))),
        });
      })
      .on('end', resolve)
      .on('error', reject);
  });

  return {
    sourceFileName: fileName,
    sourceFormat: 'CSV',
    headers,
    rows,
    truncated: skipped > 0,
    rowsSkippedByTruncation: skipped,
  };
}

/** ExcelJS cell values are rich objects; flatten to the text an analyst sees. */
function cellToText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    // Unambiguous ISO output; the shared validator decides whether the column
    // is a date and rejects anything it cannot interpret.
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'object') {
    const candidate = value as unknown as Record<string, unknown>;
    if (typeof candidate.richText === 'object' && candidate.richText !== null) {
      return (candidate.richText as Array<{ text?: unknown }>)
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('');
    }
    if (typeof candidate.text === 'string') return candidate.text;
    if (typeof candidate.result !== 'undefined') return cellToText(candidate.result as ExcelJS.CellValue);
    if (typeof candidate.hyperlink === 'string') return candidate.hyperlink;
    return String(candidate);
  }
  if (typeof value === 'number') {
    // Avoid scientific notation sneaking into a money column.
    return Number.isInteger(value) ? String(value) : value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  }
  return String(value);
}

export async function parseXlsxFile(
  filePath: string,
  fileName: string,
  options: ParseOptions,
): Promise<RawTable> {
  const rows: RawRow[] = [];
  let headers: string[] = [];
  let skipped = 0;

  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    worksheets: 'emit',
    entries: 'emit',
  });

  for await (const worksheet of workbook) {
    let sheetRow = 0;
    let headerSeen = false;

    for await (const row of worksheet) {
      sheetRow += 1;
      const values = row.values as ExcelJS.CellValue[];
      // ExcelJS row.values is 1-based; index 0 is always empty.
      const cells = Array.isArray(values) ? values.slice(1) : [];

      if (!headerSeen) {
        headerSeen = true;
        headers = cells.map((cell) => clipCell(cellToText(cell).trim()));
        continue;
      }
      if (cells.every((cell) => cellToText(cell).trim() === '')) continue;
      if (rows.length >= options.maxRows) {
        skipped += 1;
        continue;
      }
      rows.push({
        rowNumber: rows.length + 1,
        sheetRow,
        cells: cells.map((cell) => clipCell(cellToText(cell))),
      });
    }

    // Only the first worksheet is treated as the portfolio.
    break;
  }

  return {
    sourceFileName: fileName,
    sourceFormat: 'XLSX',
    headers,
    rows,
    truncated: skipped > 0,
    rowsSkippedByTruncation: skipped,
  };
}

export async function parseUploadedTable(
  filePath: string,
  fileName: string,
  sourceFormat: 'CSV' | 'XLSX',
  options: ParseOptions,
): Promise<RawTable> {
  return sourceFormat === 'CSV'
    ? parseCsvFile(filePath, fileName, options)
    : parseXlsxFile(filePath, fileName, options);
}
