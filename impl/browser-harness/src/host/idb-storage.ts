// §11 storage backend.
//
// Storage is implemented on the HOST side: the worker's null-origin iframe has
// no storage of its own (that is the isolation working as intended), so every
// operation crosses the capability port to here. Persistent via IndexedDB on
// the host origin, with records keyed [specifierAddress, storageKey] so each
// worker is confined to its own namespace (§11). Falls back to an in-memory
// backend where IndexedDB is unavailable (e.g. non-browser tests).

export interface StorageBackend {
  get(address: string, key: string): Promise<Uint8Array | undefined>;
  set(address: string, key: string, value: Uint8Array): Promise<void>;
  delete(address: string, key: string): Promise<void>;
  has(address: string, key: string): Promise<boolean>;
  listKeys(address: string, prefix?: string): Promise<string[]>;
  clear(address: string, prefix?: string): Promise<void>;
}

const DB_NAME = "anon-rpc-harness";
const STORE_NAME = "kv";

export function openStorageBackend(): Promise<StorageBackend> {
  if (typeof indexedDB === "undefined") {
    return Promise.resolve(new MemoryBackend());
  }
  return IdbBackend.open();
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

class IdbBackend implements StorageBackend {
  #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
  }

  static async open(): Promise<IdbBackend> {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(STORE_NAME);
    };
    return new IdbBackend(await req(open));
  }

  #store(mode: IDBTransactionMode): IDBObjectStore {
    return this.#db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  async get(address: string, key: string): Promise<Uint8Array | undefined> {
    return await req<Uint8Array | undefined>(this.#store("readonly").get([address, key]));
  }

  async set(address: string, key: string, value: Uint8Array): Promise<void> {
    await req(this.#store("readwrite").put(value, [address, key]));
  }

  async delete(address: string, key: string): Promise<void> {
    await req(this.#store("readwrite").delete([address, key]));
  }

  async has(address: string, key: string): Promise<boolean> {
    return (await req(this.#store("readonly").getKey([address, key]))) !== undefined;
  }

  async listKeys(address: string, prefix = ""): Promise<string[]> {
    const keys: string[] = [];
    await this.#iterate("readonly", address, prefix, (cursor) => {
      keys.push((cursor.key as [string, string])[1]);
    });
    return keys;
  }

  async clear(address: string, prefix = ""): Promise<void> {
    await this.#iterate("readwrite", address, prefix, (cursor) => {
      (cursor as IDBCursorWithValue).delete();
    });
  }

  // Walk the [address, prefix…] key range. The walk starts at the range's
  // lower bound and stops manually at the first key past the namespace or
  // prefix — exact for any key string, unlike the `prefix + "￿"` upper-
  // bound trick.
  #iterate(
    mode: IDBTransactionMode,
    address: string,
    prefix: string,
    visit: (cursor: IDBCursor) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.#store(mode);
      const range = IDBKeyRange.lowerBound([address, prefix]);
      // clear() needs value cursors: key cursors cannot delete().
      const r = mode === "readwrite" ? store.openCursor(range) : store.openKeyCursor(range);
      r.onsuccess = () => {
        const cursor = r.result;
        if (!cursor) return resolve();
        const [addr, key] = cursor.key as [string, string];
        if (addr !== address || !key.startsWith(prefix)) return resolve();
        visit(cursor);
        cursor.continue();
      };
      r.onerror = () => reject(r.error);
    });
  }
}

class MemoryBackend implements StorageBackend {
  #spaces = new Map<string, Map<string, Uint8Array>>();

  #space(address: string): Map<string, Uint8Array> {
    let m = this.#spaces.get(address);
    if (!m) this.#spaces.set(address, (m = new Map()));
    return m;
  }

  async get(address: string, key: string): Promise<Uint8Array | undefined> {
    return this.#space(address).get(key);
  }

  async set(address: string, key: string, value: Uint8Array): Promise<void> {
    this.#space(address).set(key, value);
  }

  async delete(address: string, key: string): Promise<void> {
    this.#space(address).delete(key);
  }

  async has(address: string, key: string): Promise<boolean> {
    return this.#space(address).has(key);
  }

  async listKeys(address: string, prefix = ""): Promise<string[]> {
    return [...this.#space(address).keys()].filter((k) => k.startsWith(prefix));
  }

  async clear(address: string, prefix = ""): Promise<void> {
    const space = this.#space(address);
    if (!prefix) return space.clear();
    for (const k of [...space.keys()]) if (k.startsWith(prefix)) space.delete(k);
  }
}
