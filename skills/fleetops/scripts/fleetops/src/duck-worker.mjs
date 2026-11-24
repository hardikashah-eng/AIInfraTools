// DuckDB in a worker thread, for ParquetStore's synchronous facade. Messages: { op, ... } → { ok, result | error }.
import { workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { port, signal, dir } = workerData;
const flag = new Int32Array(signal);
let con;
const q = s => `'${String(s).replace(/'/g, "''")}'`;
const COLS = "{t:'DOUBLE',day:'VARCHAR',cluster:'VARCHAR',node:'VARCHAR',gpu:'VARCHAR',job:'VARCHAR',pool:'VARCHAR',code:'VARCHAR',source:'VARCHAR',bad:'BOOLEAN',h:'VARCHAR',rec:'VARCHAR'}";
const src = kind => `read_parquet(${q(path.join(dir, kind, '**', '*.parquet'))}, hive_partitioning=true, hive_types_autocast=false, union_by_name=true)`;
const has = kind => fs.existsSync(path.join(dir, kind)) && fs.readdirSync(path.join(dir, kind)).length > 0;
const where = m => [m.dayFrom ? `day >= ${q(m.dayFrom)}` : null, m.dayTo ? `day <= ${q(m.dayTo)}` : null, m.from != null && Number.isFinite(m.from) ? `t > ${m.from}` : null, m.to != null && Number.isFinite(m.to) ? `t <= ${m.to}` : null, m.sql ? `(${m.sql})` : null].filter(Boolean).join(' AND ') || 'true';
const rows = async sql => (await con.runAndReadAll(sql)).getRowObjectsJS();

async function handle(m) {
  if (!con) { const { DuckDBInstance } = await import('@duckdb/node-api'); con = await (await DuckDBInstance.create(':memory:')).connect(); await con.run("SET TimeZone='UTC'"); }
  if (m.op === 'write') {
    const tmp = path.join(os.tmpdir(), `fleetops-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`);
    fs.writeFileSync(tmp, m.rows.map(r => JSON.stringify(r)).join('\n'));
    try {
      fs.mkdirSync(path.join(dir, m.kind), { recursive: true });
      await con.run(`COPY (SELECT * FROM read_json(${q(tmp)}, format='newline_delimited', columns=${COLS})) TO ${q(path.join(dir, m.kind))} (FORMAT parquet, PARTITION_BY (day, cluster), APPEND, FILENAME_PATTERN 'part-{uuid}', COMPRESSION zstd)`);
    } finally { fs.rmSync(tmp, { force: true }); }
    return m.rows.length;
  }
  if (m.op === 'query') { if (!has(m.kind)) return []; return (await rows(`SELECT rec FROM ${src(m.kind)} WHERE ${where(m)} ORDER BY t${m.limit ? ` LIMIT ${+m.limit}` : ''}`)).map(r => r.rec); }
  if (m.op === 'distinct') { if (!has(m.kind)) return []; return rows(`SELECT DISTINCT ${m.fields.map(f => `"${f.replace(/"/g, '')}"`).join(', ')} FROM ${src(m.kind)} WHERE ${where(m)}`); }
  if (m.op === 'hashes') { if (!has(m.kind)) return []; return (await rows(`SELECT h FROM ${src(m.kind)} WHERE day = ${q(m.day)}`)).map(r => r.h); }
  // Device rollup for one day, computed in DuckDB and written straight to the rollup store's files (no rows through JS):
  // one record per device per step, t = bin start, means, maxima, faults unioned, n = samples.
  if (m.op === 'rollup') {
    if (!has(m.kind)) return 0;
    const num = f => `TRY_CAST(json_extract_string(rec, '$.${f}') AS DOUBLE)`;
    const MEAN = ['sm', 'tensor', 'dram', 'memUsedGB', 'clockMHz', 'tempC', 'powerW', 'memTempC'], MAX = ['tempC', 'powerW', 'eccSbeTotal', 'eccDbeTotal', 'linkErrTotal', 'remapPending'];
    const fieldsSql = [...MEAN.map(f => `'${f}', round(avg(${num(f)}), 4)`), ...MAX.map(f => `'${f}Max', max(${num(f)})`)].join(', ');
    fs.mkdirSync(path.join(m.dst, m.kind), { recursive: true });
    const [{ n }] = await rows(`SELECT count(*)::DOUBLE n FROM (SELECT DISTINCT floor(t / ${+m.step}), node, gpu FROM ${src(m.kind)} WHERE day = ${q(m.day)})`);
    await con.run(`COPY (
      SELECT b AS t, strftime(to_timestamp(b), '%Y-%m-%d') AS day, cluster, node, gpu, NULL::VARCHAR AS job, NULL::VARCHAR AS pool, NULL::VARCHAR AS code, 'rollup' AS source,
        bool_or(nf > 0) AS bad, md5(rec0) AS h, rec0 AS rec FROM (
        SELECT b, cluster, node, gpu, max(nf) nf, json_object('t', b, 'node', node, 'gpu', gpu, 'vendor', any_value(vendor), 'kind', any_value(dkind), 'sku', any_value(sku), 'step', ${+m.step}, 'n', count(*),
          ${fieldsSql}, 'faults', coalesce(list_distinct(flatten(list(faults))), []), 'rollup', true)::VARCHAR AS rec0
        FROM (SELECT floor(t / ${+m.step}) * ${+m.step} AS b, cluster, node, gpu, rec, json_extract_string(rec, '$.vendor') vendor, json_extract_string(rec, '$.kind') dkind, json_extract_string(rec, '$.sku') sku,
                coalesce(json_extract_string(rec, '$.faults[*]'), []) faults, len(coalesce(json_extract_string(rec, '$.faults[*]'), [])) nf
              FROM ${src(m.kind)} WHERE day = ${q(m.day)})
        GROUP BY b, cluster, node, gpu) GROUP BY ALL
    ) TO ${q(path.join(m.dst, m.kind))} (FORMAT parquet, PARTITION_BY (day, cluster), APPEND, FILENAME_PATTERN 'part-{uuid}', COMPRESSION zstd)`);
    return n;
  }
  if (m.op === 'summary') {
    const out = {};
    for (const kind of m.kinds) if (has(kind)) {
      const [s] = await rows(`SELECT count(*)::DOUBLE n, min(t) lo, max(t) hi, count(DISTINCT day)::DOUBLE nd FROM ${src(kind)}`);
      const so = await rows(`SELECT coalesce(source, '–') s, count(*)::DOUBLE n FROM ${src(kind)} GROUP BY 1`);
      out[kind] = { records: s.n, days: s.nd, from: s.lo, to: s.hi, sources: Object.fromEntries(so.map(x => [x.s, x.n])) };
    }
    return out;
  }
  throw new Error(`unknown op ${m.op}`);
}
port.on('message', async m => {
  let reply;
  try { reply = { ok: true, result: await handle(m) }; } catch (e) { reply = { ok: false, error: e.message }; }
  port.postMessage(reply);
  Atomics.store(flag, 0, 1); Atomics.notify(flag, 0);
});
