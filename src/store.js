// Small key-value stores for watcher state and calendar snapshots. The
// caller may pass its own { load(), save(obj) }; the default is a JSON file
// in the data directory, or memory when there is none.

import fs from 'node:fs';
import path from 'node:path';

export function jsonFileStore(file, fallback = () => ({})) {
  return {
    load() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback(); }
    },
    save(obj) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
    }
  };
}

export function memoryStore(fallback = () => ({})) {
  let v = null;
  return { load: () => (v ? structuredClone(v) : fallback()), save: (obj) => { v = structuredClone(obj); } };
}
