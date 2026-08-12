/**
 * The bounded best-first frontier (CG2-08).
 *
 * The key is fixed by §7.2 and is not a preference:
 *
 *   upperBoundScore DESC, depth ASC, edgePriority DESC, nodeStableId ASC
 *
 * Every component is load-bearing. Score first is what makes the walk best-first
 * rather than breadth-first. Depth second means two states that could reach the
 * same score prefer the shorter explanation. Edge priority third keeps a
 * profile's own edge ordering visible. The node id last is what makes the order
 * *total*: without it two equal states would pop in heap-insertion order, and
 * the same query would return different results on the same index.
 *
 * State is integers in parallel arrays and the heap moves indices, so a walk
 * allocates nothing per edge and nothing per visited node. `pop()` writes the
 * winner into scalar fields, the same contract `EdgeCursor` uses: the fields are
 * overwritten by the next `pop`, so a caller that wants to keep a state copies
 * the integers it needs.
 */

/** The popped state. Readonly to the caller; the frontier owns the fields. */
export interface FrontierState {
  readonly node: number;
  readonly score: number;
  readonly depth: number;
  readonly seed: number;
  readonly parentNode: number;
  readonly parentEdge: number;
  readonly flags: number;
}

export class TraversalFrontier implements FrontierState {
  readonly capacity: number;
  size = 0;
  /** States the bound refused. A silently dropped state is an unexplained miss. */
  rejected = 0;

  node = -1;
  score = 0;
  depth = 0;
  seed = -1;
  parentNode = -1;
  parentEdge = -1;
  flags = 0;

  private readonly heap: Int32Array;
  /**
   * Released key slots. A heap holds *indices* into the key columns, so a slot
   * may not be reused while any heap position still names it — reusing
   * `size` as the next slot would overwrite a live state with a new one.
   */
  private readonly free: Int32Array;
  private freeCount = 0;
  private used = 0;

  private readonly keyScore: Int32Array;
  private readonly keyDepth: Int32Array;
  private readonly keyPriority: Int32Array;
  private readonly keyNode: Int32Array;
  private readonly keySeed: Int32Array;
  private readonly keyParentNode: Int32Array;
  private readonly keyParentEdge: Int32Array;
  private readonly keyFlags: Int32Array;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.trunc(capacity));
    this.heap = new Int32Array(this.capacity);
    this.free = new Int32Array(this.capacity);
    this.keyScore = new Int32Array(this.capacity);
    this.keyDepth = new Int32Array(this.capacity);
    this.keyPriority = new Int32Array(this.capacity);
    this.keyNode = new Int32Array(this.capacity);
    this.keySeed = new Int32Array(this.capacity);
    this.keyParentNode = new Int32Array(this.capacity);
    this.keyParentEdge = new Int32Array(this.capacity);
    this.keyFlags = new Int32Array(this.capacity);
  }

  get empty(): boolean {
    return this.size === 0;
  }

  /** The best key still queued — the traversal's own upper bound for early exit. */
  peekScore(): number {
    if (this.size === 0) return Number.NEGATIVE_INFINITY;
    return this.keyScore[this.heap[0] as number] as number;
  }

  push(
    node: number,
    score: number,
    depth: number,
    priority: number,
    seed: number,
    parentNode: number,
    parentEdge: number,
    flags: number,
  ): boolean {
    const slot = this.allocate();
    if (slot < 0) {
      this.rejected += 1;
      return false;
    }
    this.keyScore[slot] = score;
    this.keyDepth[slot] = depth;
    this.keyPriority[slot] = priority;
    this.keyNode[slot] = node;
    this.keySeed[slot] = seed;
    this.keyParentNode[slot] = parentNode;
    this.keyParentEdge[slot] = parentEdge;
    this.keyFlags[slot] = flags;
    this.heap[this.size] = slot;
    this.size += 1;
    this.siftUp(this.size - 1);
    return true;
  }

  pop(): boolean {
    if (this.size === 0) return false;
    const winner = this.heap[0] as number;
    this.size -= 1;
    if (this.size > 0) {
      this.heap[0] = this.heap[this.size] as number;
      this.siftDown(0);
    }
    this.node = this.keyNode[winner] as number;
    this.score = this.keyScore[winner] as number;
    this.depth = this.keyDepth[winner] as number;
    this.seed = this.keySeed[winner] as number;
    this.parentNode = this.keyParentNode[winner] as number;
    this.parentEdge = this.keyParentEdge[winner] as number;
    this.flags = this.keyFlags[winner] as number;
    this.free[this.freeCount] = winner;
    this.freeCount += 1;
    return true;
  }

  private allocate(): number {
    if (this.freeCount > 0) {
      this.freeCount -= 1;
      return this.free[this.freeCount] as number;
    }
    if (this.used >= this.capacity) return -1;
    const slot = this.used;
    this.used += 1;
    return slot;
  }

  /** True when `left` must pop before `right`. Total: no two slots compare equal. */
  private better(left: number, right: number): boolean {
    const scoreLeft = this.keyScore[left] as number;
    const scoreRight = this.keyScore[right] as number;
    if (scoreLeft !== scoreRight) return scoreLeft > scoreRight;
    const depthLeft = this.keyDepth[left] as number;
    const depthRight = this.keyDepth[right] as number;
    if (depthLeft !== depthRight) return depthLeft < depthRight;
    const priorityLeft = this.keyPriority[left] as number;
    const priorityRight = this.keyPriority[right] as number;
    if (priorityLeft !== priorityRight) return priorityLeft > priorityRight;
    return (this.keyNode[left] as number) < (this.keyNode[right] as number);
  }

  private siftUp(from: number): void {
    let child = from;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (!this.better(this.heap[child] as number, this.heap[parent] as number)) break;
      this.swap(child, parent);
      child = parent;
    }
  }

  private siftDown(from: number): void {
    let parent = from;
    for (;;) {
      const left = parent * 2 + 1;
      if (left >= this.size) break;
      const right = left + 1;
      let best = left;
      if (right < this.size && this.better(this.heap[right] as number, this.heap[left] as number)) best = right;
      if (!this.better(this.heap[best] as number, this.heap[parent] as number)) break;
      this.swap(best, parent);
      parent = best;
    }
  }

  private swap(left: number, right: number): void {
    const carry = this.heap[left] as number;
    this.heap[left] = this.heap[right] as number;
    this.heap[right] = carry;
  }
}
