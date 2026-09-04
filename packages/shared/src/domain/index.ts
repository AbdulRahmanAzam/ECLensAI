/**
 * Pure domain module barrel.
 *
 * Everything exported here is deterministic and dependency-free: no Express, no
 * Prisma, no filesystem, no wall clock. The API and the seed script are thin
 * adapters over these functions; the LLM copilot is never allowed to call them
 * indirectly to produce an authoritative number it did not compute itself.
 */
export * from './decimal';
export * from './dates';
export * from './errors';
export * from './staging';
export * from './pd';
export * from './ead';
export * from './discount';
export * from './scenarios';
export * from './config';
export * from './ecl';
export * from './exceptions';
export * from './serialize';
