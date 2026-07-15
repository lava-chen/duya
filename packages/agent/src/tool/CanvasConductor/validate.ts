/**
 * Canvas element validation helpers.
 *
 * Centralizes input validation for all canvas_* tools so that bad LLM
 * output is caught before hitting SQLite and produces a clear
 * structured error instead of a confusing DB failure.
 */

const VALID_ELEMENT_KINDS = new Set([
  'native/sticky',
  'native/image',
  'native/file',
  'native/connector',
  'native/group',
  'native/link',
  'widget/task-list',
  'widget/note-pad',
  'widget/pomodoro',
  'widget/news-board',
  'widget/dynamic',
]);

// Mirror of packages/conductor/src/renderer/components/native/sticky-colors.ts
// STICKY_COLOR_KEYS. Kept local to avoid a conductor workspace dep; update
// both files together when the palette changes.
const STICKY_COLORS = new Set(['yellow', 'blue', 'green', 'pink', 'purple', 'gray']);
const CONNECTOR_END_MARKERS = new Set(['arrow', 'none']);
const CONNECTOR_MARKERS = new Set(['none', 'arrow', 'open-arrow', 'circle', 'diamond', 'bar']);
const CONNECTOR_ROUTING_MODES = new Set(['elbow', 'curve', 'bezier', 'straight']);
const CONNECTOR_STROKE_STYLES = new Set(['solid', 'dashed', 'dotted']);

// Canvas bounds in grid units (1 unit = 80 px). Matches the renderer
// constant so clamping and DB clamping agree.
const CANVAS_WIDTH = 40;
const CANVAS_HEIGHT = 30;
const MIN_POSITION_VALUE = -100;
const MAX_POSITION_VALUE = 200;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

export function fail(message: string): ValidationResult {
  return { valid: false, errors: [message] };
}

export function combine(...results: ValidationResult[]): ValidationResult {
  const errors = results.flatMap((r) => r.errors);
  return { valid: errors.length === 0, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Validate a full element input before creating it.
 *
 * Checks kind, required position fields, numeric bounds, and
 * kind-specific config shapes (sticky colors, connector endpoints, etc.).
 */
export function validateElementInput(
  kind: string,
  position: Record<string, unknown>,
  config?: Record<string, unknown>,
): ValidationResult {
  if (typeof kind !== 'string' || !VALID_ELEMENT_KINDS.has(kind)) {
    return fail(
      `Invalid element kind "${kind}". Must be one of: ${Array.from(VALID_ELEMENT_KINDS).join(', ')}`,
    );
  }

  if (!isRecord(position)) {
    return fail('position must be an object');
  }

  const positionChecks: ValidationResult[] = [];

  if (!isFiniteNumber(position.x)) {
    positionChecks.push(fail('position.x must be a finite number'));
  }
  if (!isFiniteNumber(position.y)) {
    positionChecks.push(fail('position.y must be a finite number'));
  }

  for (const key of ['x', 'y', 'w', 'h', 'zIndex', 'rotation']) {
    const value = position[key];
    if (value === undefined) continue;
    if (!isFiniteNumber(value)) {
      positionChecks.push(fail(`position.${key} must be a finite number`));
    } else if ((key === 'x' || key === 'y' || key === 'w' || key === 'h') && ((value as number) < MIN_POSITION_VALUE || (value as number) > MAX_POSITION_VALUE)) {
      positionChecks.push(fail(`position.${key} out of allowed range [${MIN_POSITION_VALUE}, ${MAX_POSITION_VALUE}]`));
    }
  }

  const configChecks: ValidationResult[] = [];
  if (config !== undefined && !isRecord(config)) {
    configChecks.push(fail('config must be an object'));
  } else if (config !== undefined) {
    configChecks.push(validateKindConfig(kind, config));
  }

  return combine(...positionChecks, ...configChecks);
}

/**
 * Validate kind-specific config fields.
 */
export function validateKindConfig(kind: string, config: Record<string, unknown>): ValidationResult {
  const checks: ValidationResult[] = [];

  if (kind === 'native/sticky') {
    const color = config.color;
    if (color !== undefined && (typeof color !== 'string' || !STICKY_COLORS.has(color))) {
      checks.push(
        fail(
          `sticky color must be one of: ${Array.from(STICKY_COLORS).join(', ')}`,
        ),
      );
    }
    const fontSize = config.fontSize;
    if (fontSize !== undefined && (!isFiniteNumber(fontSize) || (fontSize as number) <= 0)) {
      checks.push(fail('sticky fontSize must be a positive finite number'));
    }
  }

  if (kind === 'native/connector') {
    checks.push(validateConnectorShape(config));
  }

  if (kind === 'native/image') {
    const opacity = config.opacity;
    if (opacity !== undefined && (!isFiniteNumber(opacity) || (opacity as number) < 0 || (opacity as number) > 1)) {
      checks.push(fail('image opacity must be a number between 0 and 1'));
    }
    const borderRadius = config.borderRadius;
    if (borderRadius !== undefined && (!isFiniteNumber(borderRadius) || (borderRadius as number) < 0)) {
      checks.push(fail('image borderRadius must be a non-negative finite number'));
    }
  }

  if (kind === 'native/link') {
    const linkType = config.linkType;
    if (linkType !== undefined && !['url', 'session', 'canvas'].includes(linkType as string)) {
      checks.push(fail('link linkType must be one of: url, session, canvas'));
    }
    const expandedSize = config.expandedSize;
    if (expandedSize !== undefined) {
      if (!isRecord(expandedSize)) {
        checks.push(fail('link expandedSize must be an object with w and h'));
      } else {
        if (!isFiniteNumber(expandedSize.w)) {
          checks.push(fail('link expandedSize.w must be a finite number'));
        }
        if (!isFiniteNumber(expandedSize.h)) {
          checks.push(fail('link expandedSize.h must be a finite number'));
        }
      }
    }
  }

  if (kind === 'widget/dynamic') {
    // sourceCode is required for widget/dynamic, but it's a top-level field in the tool input,
    // not in config. Validate config is an object (optional metadata).
    if (config !== null && typeof config !== 'object') {
      checks.push(fail('widget/dynamic config must be an object or null (sourceCode is a separate field)'));
    }
    // Optional: validate config.moduleName if present
    if (config && typeof config.moduleName === 'string' && config.moduleName.length > 64) {
      checks.push(fail('widget/dynamic config.moduleName too long (max 64 chars)'));
    }
  }

  return combine(...checks);
}

/**
 * Validate connector config shape.
 */
export function validateConnectorShape(config: Record<string, unknown>): ValidationResult {
  const checks: ValidationResult[] = [];

  const source = config.source;
  const target = config.target;

  if (source === undefined) {
    checks.push(fail('connector config.source is required'));
  }
  if (target === undefined) {
    checks.push(fail('connector config.target is required'));
  }

  const endMarker = config.endMarker;
  if (endMarker !== undefined && (typeof endMarker !== 'string' || !CONNECTOR_END_MARKERS.has(endMarker))) {
    checks.push(
      fail(
        `connector endMarker must be one of: ${Array.from(CONNECTOR_END_MARKERS).join(', ')}`,
      ),
    );
  }

  const strokeWidth = config.strokeWidth;
  if (strokeWidth !== undefined && (!isFiniteNumber(strokeWidth) || (strokeWidth as number) <= 0)) {
    checks.push(fail('connector strokeWidth must be a positive finite number'));
  }

  const curvature = config.curvature;
  if (curvature !== undefined && (!isFiniteNumber(curvature) || (curvature as number) < 0)) {
    checks.push(fail('connector curvature must be a non-negative finite number'));
  }

  const routingMode = config.routingMode;
  if (routingMode !== undefined && (typeof routingMode !== 'string' || !CONNECTOR_ROUTING_MODES.has(routingMode))) {
    checks.push(fail(`connector routingMode must be one of: ${Array.from(CONNECTOR_ROUTING_MODES).join(', ')}`));
  }

  for (const field of ['startMarker', 'endMarker'] as const) {
    const marker = config[field];
    if (marker !== undefined && (typeof marker !== 'string' || !CONNECTOR_MARKERS.has(marker))) {
      checks.push(fail(`connector ${field} must be one of: ${Array.from(CONNECTOR_MARKERS).join(', ')}`));
    }
  }

  const strokeStyle = config.strokeStyle;
  if (strokeStyle !== undefined && (typeof strokeStyle !== 'string' || !CONNECTOR_STROKE_STYLES.has(strokeStyle))) {
    checks.push(fail(`connector strokeStyle must be one of: ${Array.from(CONNECTOR_STROKE_STYLES).join(', ')}`));
  }

  const label = config.label;
  if (label !== undefined && typeof label !== 'string') {
    checks.push(fail('connector label must be a string'));
  }

  const waypoints = config.waypoints;
  if (waypoints !== undefined) {
    if (!Array.isArray(waypoints)) {
      checks.push(fail('connector waypoints must be an array of {x, y} points'));
    } else if (waypoints.some((point) => !isRecord(point) || !isFiniteNumber(point.x) || !isFiniteNumber(point.y))) {
      checks.push(fail('connector waypoint coordinates must be finite numbers'));
    }
  }

  const curveControlOffsets = config.curveControlOffsets;
  if (curveControlOffsets !== undefined) {
    if (!isRecord(curveControlOffsets)) {
      checks.push(fail('connector curveControlOffsets must contain source and target points'));
    } else {
      for (const field of ['source', 'target'] as const) {
        const point = curveControlOffsets[field];
        if (!isRecord(point) || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) {
          checks.push(fail(`connector curveControlOffsets.${field} must contain finite x and y numbers`));
        }
      }
    }
  }

  return combine(...checks);
}

/**
 * Clamp a position to canvas bounds with a margin.
 * Keeps the element fully inside [0, canvasSize] when w/h are known.
 */
export function clampPositionToCanvas(
  position: Record<string, unknown>,
  width = CANVAS_WIDTH,      // 40 grid units
  height = CANVAS_HEIGHT,    // 30 grid units
  margin = 1,                // 1 grid unit (80px) — was 20, caused all elements clamped to (20,20)
): Record<string, unknown> {
  const clamped = { ...position };

  if (isFiniteNumber(clamped.x)) {
    const x = clamped.x as number;
    const w = isFiniteNumber(clamped.w) ? (clamped.w as number) : 0;
    clamped.x = Math.max(margin, Math.min(x, width - w - margin));
  }

  if (isFiniteNumber(clamped.y)) {
    const y = clamped.y as number;
    const h = isFiniteNumber(clamped.h) ? (clamped.h as number) : 0;
    clamped.y = Math.max(margin, Math.min(y, height - h - margin));
  }

  return clamped;
}

/**
 * Return a string summary of the validation result for IPC error messages.
 */
export function formatValidationErrors(result: ValidationResult): string {
  if (result.valid) return '';
  return result.errors.join('; ');
}
