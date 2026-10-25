import type { QueuedMessage } from "@ditfa-ide/contract";

export interface QueueItem<T> extends QueuedMessage {
  /** What it takes to send the message later (input, attachments, skill), opaque to the queue. */
  payload: T;
}

/**
 * Messages typed while a turn runs, sent one at a time as turns end.
 *
 * The queue pauses itself when a turn fails or is stopped: sending the next message on top of a failure, or right
 * after the user said stop, is rarely what they meant. Resume picks up where it left off.
 */
export class MessageQueue<T> {
  private items: QueueItem<T>[] = [];
  private paused = false;
  private counter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.items.length;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** What the panel shows: everything but the payload. */
  view(): QueuedMessage[] {
    return this.items.map(({ id, text, attachments, createdAt }) => ({ id, text, attachments, createdAt }));
  }

  enqueue(text: string, attachments: string[], payload: T): QueueItem<T> {
    this.counter += 1;
    const item: QueueItem<T> = { id: `queued-${this.counter}`, text, attachments, createdAt: this.now(), payload };
    this.items.push(item);
    return item;
  }

  /** Removes and returns the message with `id`. */
  take(id: string): QueueItem<T> | null {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const [item] = this.items.splice(index, 1);
    return item ?? null;
  }

  /** The next message to send, or `null` when the queue is empty or paused. */
  next(): QueueItem<T> | null {
    if (this.paused) return null;
    return this.items.shift() ?? null;
  }

  pause(): void {
    if (this.items.length > 0) this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  clear(): void {
    this.items = [];
    this.paused = false;
  }
}
