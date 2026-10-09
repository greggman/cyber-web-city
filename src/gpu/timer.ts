// GPU pass timing with timestamp queries (when the feature is available).
export class GpuTimer {
  private querySet: GPUQuerySet | null = null;
  private resolve: GPUBuffer | null = null;
  private readbacks: GPUBuffer[] = [];
  private labels: string[] = [];
  private index = 0;
  private pending = false;
  readonly max = 32;
  /** Last measured milliseconds per label. */
  results: Record<string, number> = {};
  frameMs = 0;

  constructor(
    private readonly device: GPUDevice,
    enabled: boolean,
  ) {
    if (!enabled) return;
    this.querySet = device.createQuerySet({
      label: 'timer/queries',
      type: 'timestamp',
      count: this.max * 2,
    });
    this.resolve = device.createBuffer({
      label: 'timer/resolve',
      size: this.max * 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readbacks = [0, 1].map(i =>
      device.createBuffer({
        label: `timer/readback${i}`,
        size: this.max * 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
    );
  }

  get enabled() {
    return this.querySet !== null;
  }

  beginFrame() {
    this.index = 0;
    this.labels = [];
  }

  /** timestampWrites for a pass descriptor (or undefined when disabled/full). */
  writes(label: string): GPURenderPassTimestampWrites | undefined {
    if (!this.querySet || this.pending || this.index >= this.max)
      return undefined;
    const i = this.index++;
    this.labels.push(label);
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: i * 2,
      endOfPassWriteIndex: i * 2 + 1,
    };
  }

  endFrame(encoder: GPUCommandEncoder) {
    if (!this.querySet || this.pending || this.index === 0) return;
    const n = this.index;
    const labels = this.labels.slice();
    encoder.resolveQuerySet(this.querySet, 0, n * 2, this.resolve!, 0);
    const rb = this.readbacks[0];
    encoder.copyBufferToBuffer(this.resolve!, 0, rb, 0, n * 16);
    this.pending = true;
    queueMicrotask(() => {
      void this.device.queue.onSubmittedWorkDone().then(() =>
        rb.mapAsync(GPUMapMode.READ).then(() => {
          const t = new BigInt64Array(rb.getMappedRange().slice(0, n * 16));
          const r: Record<string, number> = {};
          let lo = t[0];
          let hi = t[1];
          for (let k = 0; k < n; k++) {
            const ms = Number(t[k * 2 + 1] - t[k * 2]) / 1e6;
            r[labels[k]] = (r[labels[k]] ?? 0) + ms;
            if (t[k * 2] < lo) lo = t[k * 2];
            if (t[k * 2 + 1] > hi) hi = t[k * 2 + 1];
          }
          this.results = r;
          // Per-pass times are quantized by the browser; the span from first
          // begin to last end is the reliable whole-frame GPU time.
          this.frameMs = Number(hi - lo) / 1e6;
          rb.unmap();
          this.pending = false;
        }),
      );
    });
  }
}

let active: GpuTimer | null = null;

export function setActiveTimer(t: GpuTimer | null) {
  active = t;
}

/** timestampWrites for the active frame timer (undefined when disabled). */
export function tw(label: string): GPURenderPassTimestampWrites | undefined {
  return active?.writes(label);
}
