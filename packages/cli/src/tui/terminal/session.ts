import { EscapeSafeWriter } from '../bounded-writer.js';
import type { TerminalSize } from './viewport.js';

export interface TerminalSessionOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  readonly size?: () => TerminalSize;
}

type GeometryStream = NodeJS.WritableStream & {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
};

type BlessedOutput = EscapeSafeWriter & {
  readonly isTTY: boolean;
  readonly columns: number;
  readonly rows: number;
};

function validSize(size: TerminalSize | undefined): size is TerminalSize {
  return size !== undefined
    && Number.isFinite(size.rows)
    && size.rows > 0
    && Number.isFinite(size.columns)
    && size.columns > 0;
}

function streamSize(stream: GeometryStream): TerminalSize | undefined {
  const size = { rows: stream.rows, columns: stream.columns };
  return validSize(size as TerminalSize) ? size as TerminalSize : undefined;
}

function hasTtyGeometry(stream: GeometryStream): boolean {
  return streamSize(stream) !== undefined;
}

/** Owns the terminal streams and resize subscription for one TUI lifetime. */
export class TerminalSession {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly writer: BlessedOutput;

  private readonly sizeProvider: (() => TerminalSize) | undefined;
  private readonly resizeSource: NodeJS.WriteStream | GeometryStream;
  private disposed = false;
  private readonly forwardResize = (): void => {
    this.writer.emit('resize');
  };

  constructor(options: TerminalSessionOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.sizeProvider = options.size;

    const outputGeometry = this.output as GeometryStream;
    this.resizeSource = hasTtyGeometry(outputGeometry) ? outputGeometry : process.stdout;
    const writer = new EscapeSafeWriter({ sink: this.output }) as BlessedOutput;

    Object.defineProperties(writer, {
      isTTY: { configurable: false, enumerable: true, value: true },
      columns: {
        configurable: false,
        enumerable: true,
        get: () => this.size().columns,
      },
      rows: {
        configurable: false,
        enumerable: true,
        get: () => this.size().rows,
      },
    });

    this.writer = writer;
    this.resizeSource.on('resize', this.forwardResize);
  }

  size(): TerminalSize {
    if (this.sizeProvider !== undefined) return this.sizeProvider();

    const outputSize = streamSize(this.output as GeometryStream);
    if (hasTtyGeometry(this.output as GeometryStream) && outputSize !== undefined) {
      return outputSize;
    }

    const stdoutSize = streamSize(process.stdout);
    return stdoutSize ?? { rows: 24, columns: 80 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeSource.removeListener('resize', this.forwardResize);
    this.writer.flush();
  }
}
