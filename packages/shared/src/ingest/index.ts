/**
 * Ingestion module barrel.
 *
 * Everything here is pure and browser-safe: the API supplies the actual CSV /
 * XLSX byte parsing (csv-parse and exceljs streaming readers live in
 * `apps/api/src/services/ingest`), converts the file into a `RawTable`, and
 * hands it to these functions for mapping, normalization and validation.
 */
export * from './columns';
export * from './normalize';
export * from './validate';
export * from './generator';
export * from './history';
