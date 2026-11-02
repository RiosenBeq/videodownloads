/** Persistent download history (newest first, bounded). */
import { randomUUID } from 'node:crypto';
import type { HistoryEntry } from '@clipkeeper/shared';
import { exists, readJson, writeJsonAtomic } from './fs/files';

const MAX_ENTRIES = 1000;

export class HistoryStore {
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private entries: HistoryEntry[],
  ) {}

  static async load(file: string): Promise<HistoryStore> {
    const stored = await readJson<HistoryEntry[]>(file);
    return new HistoryStore(file, Array.isArray(stored) ? stored.slice(0, MAX_ENTRIES) : []);
  }

  list(limit = MAX_ENTRIES): HistoryEntry[] {
    return this.entries.slice(0, limit);
  }

  async add(entry: Omit<HistoryEntry, 'id'> & { id?: string }): Promise<HistoryEntry> {
    const full: HistoryEntry = { ...entry, id: entry.id ?? randomUUID() };
    this.entries = [full, ...this.entries.filter((e) => e.id !== full.id)].slice(0, MAX_ENTRIES);
    await this.persist();
    return full;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    await this.persist();
    return true;
  }

  async clear(): Promise<void> {
    this.entries = [];
    await this.persist();
  }

  /** A completed download with the same key whose file still exists. */
  async findCompleted(key: string): Promise<HistoryEntry | undefined> {
    for (const entry of this.entries) {
      if (entry.key === key && entry.status === 'completed' && (!entry.filePath || (await exists(entry.filePath)))) return entry;
    }
    return undefined;
  }

  private persist(): Promise<void> {
    const snapshot = this.entries;
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, snapshot)).catch(() => undefined);
    return this.writing;
  }
}
