// Read a large text file line by line without loading it whole (synchronous, so generators can consume it).
import fs from 'node:fs';
export function* readLines(file, chunk = 1 << 20) {
  const fd = fs.openSync(file, 'r'), buf = Buffer.alloc(chunk);
  let rest = '', n;
  try {
    while ((n = fs.readSync(fd, buf, 0, chunk, null)) > 0) {
      const parts = (rest + buf.toString('utf8', 0, n)).split('\n');
      rest = parts.pop();
      for (const p of parts) yield p.endsWith('\r') ? p.slice(0, -1) : p;
    }
    if (rest) yield rest;
  } finally { fs.closeSync(fd); }
}
