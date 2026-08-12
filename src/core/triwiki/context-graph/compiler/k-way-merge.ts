/**
 * Stable k-way merge over pre-sorted groups.
 *
 * The compiler merges one group per source fragment rather than concatenating
 * everything and sorting, because §9.4 forbids materializing the whole node and
 * edge population as one object graph — the merge has to stay proportional to the
 * number of open cursors, not to the size of the workspace.
 *
 * Stability is not a nicety here. The writer's determinism contract says the same
 * snapshot produces byte-identical index bytes, and those bytes are the content
 * address a generation is named by. If two fragments contribute the same node id,
 * whichever one folds first decides the surviving fields — so ties resolve by
 * group index, and group order is the caller's total order over
 * `(extractor, sourcePath)`. Nothing about which fragments were reused and which
 * were re-extracted can reach the output.
 */

/** Codepoint order, matching `compareContextGraphIds`; never `localeCompare`, whose result depends on host ICU. */
function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Binary min-heap of group indices, ordered by (head key, group index). */
class CursorHeap {
  private readonly heap: number[] = [];

  constructor(private readonly keyAt: (group: number) => string) {}

  private less(left: number, right: number): boolean {
    const byKey = compareKeys(this.keyAt(left), this.keyAt(right));
    return byKey !== 0 ? byKey < 0 : left < right;
  }

  private swap(left: number, right: number): void {
    const value = this.heap[left] as number;
    this.heap[left] = this.heap[right] as number;
    this.heap[right] = value;
  }

  push(group: number): void {
    this.heap.push(group);
    for (let index = this.heap.length - 1; index > 0; ) {
      const parent = (index - 1) >> 1;
      if (!this.less(this.heap[index] as number, this.heap[parent] as number)) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  pop(): number | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0] as number;
    const last = this.heap.pop() as number;
    if (this.heap.length === 0) return top;
    this.heap[0] = last;
    for (let index = 0; ; ) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.heap.length && this.less(this.heap[left] as number, this.heap[smallest] as number)) smallest = left;
      if (right < this.heap.length && this.less(this.heap[right] as number, this.heap[smallest] as number)) smallest = right;
      if (smallest === index) break;
      this.swap(index, smallest);
      index = smallest;
    }
    return top;
  }

  get size(): number {
    return this.heap.length;
  }
}

export interface KWayMergeInput<TRow, TFolded> {
  /** Each group must already be sorted ascending by `keyOf`; unsorted input is a caller bug, not a runtime mode. */
  readonly groups: readonly (readonly TRow[])[];
  keyOf(row: TRow): string;
  seed(row: TRow, group: number): TFolded;
  fold(accumulated: TFolded, row: TRow, group: number): TFolded;
}

/** One folded value per distinct key, emitted in ascending key order. */
export function kWayMerge<TRow, TFolded>(input: KWayMergeInput<TRow, TFolded>): TFolded[] {
  const positions = input.groups.map(() => 0);
  const headKey = (group: number): string => {
    const rows = input.groups[group] as readonly TRow[];
    return input.keyOf(rows[positions[group] as number] as TRow);
  };
  const heap = new CursorHeap(headKey);
  for (const [group, rows] of input.groups.entries()) {
    if (rows.length > 0) heap.push(group);
  }

  const out: TFolded[] = [];
  let currentKey: string | null = null;
  let accumulated: TFolded | null = null;
  while (heap.size > 0) {
    const group = heap.pop() as number;
    const rows = input.groups[group] as readonly TRow[];
    const position = positions[group] as number;
    const row = rows[position] as TRow;
    const key = input.keyOf(row);
    if (currentKey === null || key !== currentKey) {
      if (accumulated !== null) out.push(accumulated);
      currentKey = key;
      accumulated = input.seed(row, group);
    } else {
      accumulated = input.fold(accumulated as TFolded, row, group);
    }
    positions[group] = position + 1;
    if (position + 1 < rows.length) heap.push(group);
  }
  if (accumulated !== null) out.push(accumulated);
  return out;
}
