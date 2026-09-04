/**
 * Identifier generation.
 *
 * Two kinds of id exist and they are never interchangeable:
 *
 *   - internal `id`: opaque, used for foreign keys. We generate it ourselves
 *     rather than relying on `@default(cuid())` so that bulk `createMany`
 *     inserts can be wired together (a parent id must be known before the child
 *     rows referencing it are written, and `createMany` returns no ids).
 *   - `publicId`: short, human-quotable, used in URLs and audit detail so an
 *     analyst can read a reference aloud without transcribing a cuid.
 */
import { randomBytes } from 'node:crypto';

export function newId(): string {
  return `${Date.now().toString(36)}${randomBytes(9).toString('hex')}`;
}

export function newPublicId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
}
