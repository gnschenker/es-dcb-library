import type pg from 'pg';
import type { QueryDefinition } from '../query/types.js';
import type { StoredEvent } from '../types.js';

/**
 * Called once per matching event, inside an open transaction.
 * Must NOT call BEGIN, COMMIT, or ROLLBACK.
 * Must be idempotent — at-least-once delivery guarantee.
 */
export type ProjectionHandler = (
  event: StoredEvent,
  client: pg.PoolClient,
) => Promise<void>;

/**
 * Called once during ProjectionManager.initialize().
 * Must use IF NOT EXISTS / idempotent DDL.
 * Only put CREATE TABLE IF NOT EXISTS here — avoid slow DDL like index creation.
 */
export type ProjectionSetup = (client: pg.PoolClient) => Promise<void>;

/**
 * Complete definition of one projection.
 * Use defineProjection() to create validated instances.
 */
export interface ProjectionDefinition {
  /**
   * Stable unique identifier — becomes the checkpoint row key.
   * Convention: /^[a-zA-Z][a-zA-Z0-9\-_]{0,127}$/
   */
  readonly name: string;

  /**
   * The subset of events this projection cares about.
   * Uses the existing query DSL. Must have at least one clause.
   */
  readonly query: QueryDefinition;

  /**
   * Optional: create read-model tables idempotently.
   * Called once during ProjectionManager.initialize().
   */
  readonly setup?: ProjectionSetup;

  /**
   * Called once per matching event, inside an open transaction.
   * Checkpoint update committed in same transaction — atomically.
   */
  readonly handler: ProjectionHandler;
}

/**
 * Map of event type string → typed handler function.
 * Used with createEventDispatcher().
 */
export type DispatchHandlers = {
  [eventType: string]: (
    payload: Record<string, unknown>,
    event: StoredEvent,
    client: pg.PoolClient,
  ) => Promise<void>;
};

const PROJECTION_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9\-_]{0,127}$/;

/**
 * Validates a ProjectionDefinition and returns it typed.
 * Throws if name is empty, whitespace-only, does not match naming convention,
 * or if query has no clauses.
 */
export function defineProjection(def: ProjectionDefinition): ProjectionDefinition {
  if (!def.name || def.name.trim() === '') {
    throw new Error('defineProjection: name must be a non-empty string');
  }
  if (!PROJECTION_NAME_PATTERN.test(def.name)) {
    throw new Error(
      `defineProjection: name "${def.name}" must match /^[a-zA-Z][a-zA-Z0-9\\-_]{0,127}$/`,
    );
  }
  if (!def.query || !Array.isArray(def.query._clauses) || def.query._clauses.length === 0) {
    throw new Error(
      `defineProjection: "${def.name}" must have at least one event type in query`,
    );
  }
  return def;
}

/**
 * Creates a ProjectionHandler that dispatches to typed sub-handlers by event type.
 * Events with no matching handler are silently skipped.
 *
 * Usage:
 * ```typescript
 * handler: createEventDispatcher({
 *   TeacherHired: async (payload: TeacherHiredPayload, _event, client) => { ... },
 *   TeacherDismissed: async (payload: TeacherDismissedPayload, _event, client) => { ... },
 * })
 * ```
 */
export function createEventDispatcher(handlers: DispatchHandlers): ProjectionHandler {
  return async (event: StoredEvent, client: pg.PoolClient): Promise<void> => {
    const h = handlers[event.type];
    if (h !== undefined) {
      await h(event.payload as Record<string, unknown>, event, client);
    }
  };
}
