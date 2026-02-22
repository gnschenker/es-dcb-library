import pg from 'pg';
import type { EventStore } from '../types.js';
import type { ProjectionDefinition } from './types.js';
import {
  sleep,
  ResolvedConfig,
  ProjectionStatus,
  ProjectionLoopState,
  WaitSignalResult,
  createWaitForSignal,
  runProjectionLoop,
  ManagedListenClient,
} from './loop.js';
import { applyProjectionSchema } from './schema.js';

export interface ProjectionManagerConfig {
  /** Connection pool for read-model writes and checkpoint updates. */
  pool: pg.Pool;
  /** Event store — provides stream() for catch-up and live phases. */
  store: EventStore;
  /** Projection definitions to manage. */
  projections: ProjectionDefinition[];
  onError?: (projectionName: string, error: unknown) => void;
  onRetry?: (projectionName: string, attempt: number, error: unknown, nextDelayMs: number) => void;
  onStatusChange?: (
    projectionName: string,
    oldStatus: ProjectionStatus,
    newStatus: ProjectionStatus,
  ) => void;
  maxRetries?: number;       // default 3
  retryDelayMs?: number;     // default 500ms
  streamBatchSize?: number;  // default 200
  pollIntervalMs?: number;   // default 5000ms
  setupTimeoutMs?: number;   // default 30000ms
  singleInstance?: boolean;
  dryRun?: boolean;
}

export type { ProjectionStatus } from './loop.js';   // re-export for consumers

export interface ProjectionState {
  name: string;
  status: ProjectionStatus;
  lastProcessedPosition: bigint;
  lastUpdatedAt: Date | null;
  errorDetail?: unknown;
}

export class ProjectionManager {
  private readonly resolved: ResolvedConfig;
  private listenClient: ManagedListenClient | null = null;
  private readonly loopStates: Map<string, ProjectionLoopState> = new Map();
  private readonly loopPromises: Promise<void>[] = [];
  private readonly lockClients: Map<string, pg.Client> = new Map();
  constructor(private readonly config: ProjectionManagerConfig) {
    this.resolved = {
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 500,
      streamBatchSize: config.streamBatchSize ?? 200,
      pollIntervalMs: config.pollIntervalMs ?? 5_000,
      setupTimeoutMs: config.setupTimeoutMs ?? 30_000,
      dryRun: config.dryRun ?? false,
      onError: config.onError ?? ((_name, err) => {
        console.error('[projections] projection failed:', err);
      }),
      ...(config.onRetry !== undefined ? { onRetry: config.onRetry } : {}),
      ...(config.onStatusChange !== undefined ? { onStatusChange: config.onStatusChange } : {}),
    };
  }
}
