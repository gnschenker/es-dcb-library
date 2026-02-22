// Public API barrel for es-dcb-library/projections subpath.
// ProjectionManager will be added in task P-07.

export { defineProjection, createEventDispatcher } from './types.js';
export type {
  ProjectionDefinition,
  ProjectionHandler,
  ProjectionSetup,
  DispatchHandlers,
} from './types.js';
