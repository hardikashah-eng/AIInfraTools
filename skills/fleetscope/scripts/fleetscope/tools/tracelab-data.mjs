// The TraceLab coding-agent trace (UW SyFI, CC BY 4.0): 8,058 Claude Code and Codex sessions, 665,453 model calls, with
// the providers' cache accounting, timing and tool calls. Fetched at a pinned release, checked by SHA-256 and cached; it
// is not copied into this repository. https://github.com/uw-syfi/TraceLab
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const TRACELAB = {
  url: 'https://github.com/uw-syfi/TraceLab/releases/download/v0.0.2/syfi_coding_trace.jsonl.gz', release: 'v0.0.2',
  sha256: '11ce51ec0a25e3d1d95b025bca2f7d1647e47571eb7cc968acd5fc64d4b4fb65', license: 'CC BY 4.0', citation: 'Zhu et al., TraceLab: Characterizing Coding Agent Workloads for LLM Serving, arXiv:2606.30560 (2026)',
};

// a local copy (--file, or TRACELAB_FILE) is used as is after the checksum; otherwise download once into the cache
export async function tracelabFile(local = process.env.TRACELAB_FILE, cache = path.join(os.homedir(), '.cache', 'aiinfra-tools', 'tracelab', TRACELAB.release)) {
  const file = local || path.join(cache, 'syfi_coding_trace.jsonl.gz');
  if (!fs.existsSync(file)) {
    if (local) throw new Error(`${local}: not found`);
    fs.mkdirSync(cache, { recursive: true });
    const res = await fetch(TRACELAB.url);
    if (!res.ok) throw new Error(`download ${TRACELAB.url}: HTTP ${res.status}`);
    fs.writeFileSync(file + '.part', Buffer.from(await res.arrayBuffer())); fs.renameSync(file + '.part', file);
  }
  const h = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (h !== TRACELAB.sha256) throw new Error(`${file}: SHA-256 ${h} is not TraceLab ${TRACELAB.release}'s ${TRACELAB.sha256}`);
  return file;
}
