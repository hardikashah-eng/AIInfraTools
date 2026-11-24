// Workload Intelligence: deterministic, privacy-conscious request profiling and synthetic replay.
// Reuses FleetScope's canonical trace contract; never reads or exports prompt/response contents.
export const PRESETS = Object.freeze({
  "coding-agent": { label: "Coding agent", calls: 16, input: 12000, output: 350, cachedRatio: 0.65, thinkS: 7, e2eS: 5, sessionSpacingS: 3, ttftS: 0.8, growth: 0.055 },
  "chat": { label: "Interactive chat", calls: 6, input: 1800, output: 420, cachedRatio: 0.25, thinkS: 35, e2eS: 3, sessionSpacingS: 1, ttftS: 0.5, growth: 0.12 },
  "report-generation": { label: "Report generation", calls: 3, input: 24000, output: 3400, cachedRatio: 0.12, thinkS: 12, e2eS: 32, sessionSpacingS: 8, ttftS: 3, growth: 0.08 },
  "rag-search": { label: "RAG / enterprise search", calls: 3, input: 5500, output: 650, cachedRatio: 0.32, thinkS: 3, e2eS: 6, sessionSpacingS: 2, ttftS: 0.9, growth: 0.03 },
  "deep-research": { label: "Deep research agent", calls: 25, input: 14000, output: 1100, cachedRatio: 0.48, thinkS: 18, e2eS: 12, sessionSpacingS: 10, ttftS: 1.6, growth: 0.07 },
  "autocomplete": { label: "Code autocomplete", calls: 9, input: 1400, output: 90, cachedRatio: 0.55, thinkS: 4, e2eS: 0.45, sessionSpacingS: 0.4, ttftS: 0.12, growth: 0.01 }
});
const finite = n => typeof n === "number" && Number.isFinite(n);
const bounded = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
export function percentile(values, pct) {
  if (!values.length) return null;
  const sorted = values.filter(finite).sort((a,b) => a-b);
  if (!sorted.length) return null;
  const pos = (sorted.length-1)*pct, low = Math.floor(pos), f = pos-low;
  return sorted[low]*(1-f) + sorted[Math.min(low+1,sorted.length-1)]*f;
}
function stats(values) {
  const x = values.filter(finite);
  return { count:x.length, p50:percentile(x,0.5), p95:percentile(x,0.95), p99:percentile(x,0.99), mean:x.length?x.reduce((a,b)=>a+b,0)/x.length:null };
}
// Canonical rows: t (seconds), isl/osl (tokens), cached (tokens), e2e/ttft (seconds), session.
export function normalize(rows) {
  return rows.filter(r=>finite(+r.t) && +r.isl>0 && +r.osl>0).map(r=>({
    t:+r.t, isl:Math.round(+r.isl), osl:Math.round(+r.osl),
    ...(finite(+r.cached) && r.cached != null && r.cached!=="" ? {cached:bounded(Math.round(+r.cached),0,Math.round(+r.isl))}:{}),
    ...(r.ttft!=null && r.ttft!=="" && finite(+r.ttft) && +r.ttft>=0?{ttft:+r.ttft}:{}),
    ...(r.e2e!=null && r.e2e!=="" && finite(+r.e2e) && +r.e2e>=0?{e2e:+r.e2e}:{}),
    ...(r.session!=null && String(r.session)!=="" ? {session:String(r.session)}:{})
  })).sort((a,b)=>a.t-b.t);
}
export function profile(rows, { type="unknown", source="trace" }={}) {
  const data=normalize(rows);
  if(!data.length) throw new Error("no usable requests (need t, isl>0, osl>0)");
  const sessions=new Map(), gaps=[], turnCounts=[];
  data.forEach((r,i)=> {
    if(r.session==null)return;
    if(!sessions.has(r.session)) sessions.set(r.session,[]);
    sessions.get(r.session).push(r);
  });
  for(const turns of sessions.values()){
    turns.sort((a,b)=>a.t-b.t);
    turnCounts.push(turns.length);
    for(let i=1;i<turns.length;i++){
      const prev=turns[i-1];
      if(prev.e2e!=null) gaps.push(Math.max(0,turns[i].t-(prev.t+prev.e2e)));
    }
  }
  const measuredCache=data.filter(r=>r.cached!=null);
  const cached=measuredCache.reduce((s,r)=>s+r.cached,0);
  const sampledInput=measuredCache.reduce((s,r)=>s+r.isl,0);
  const min=data[0].t,max=data[data.length-1].t;
  const buckets=new Map();
  for(const r of data){ const b=Math.floor((r.t-min)/60);buckets.set(b,(buckets.get(b)||0)+1); }
  return {
    schema:"aiinfratools.workload.v1",type,source,requests:data.length,sessions:sessions.size,
    windowS:Math.max(0,max-min),
    tokenDistributions:{input:stats(data.map(r=>r.isl)),output:stats(data.map(r=>r.osl))},
    latencyS:{ttft:stats(data.filter(r=>r.ttft!=null).map(r=>r.ttft)),endToEnd:stats(data.filter(r=>r.e2e!=null).map(r=>r.e2e))},
    session:{callsPerSession:stats(turnCounts),observedIdleGapS:stats(gaps),missingSessionIds:data.length-[...sessions.values()].reduce((s,x)=>s+x.length,0),missingEndToEndForGaps:data.filter(r=>r.session!=null&&r.e2e==null).length},
    cache:{coverage:measuredCache.length/data.length,hitRatio:sampledInput?cached/sampledInput:null,cacheTokens:cached,observedTokens:sampledInput},
    arrivals:{peakRequestsPerMinute:Math.max(...buckets.values()),meanRequestsPerMinute:data.length/Math.max(1,(max-min)/60)},
    caveats:["Profile type is supplied by the caller; not inferred from token counts.","Cache ratio is measured only for rows reporting cached tokens.","Recorded gaps include human/tool delay and cannot distinguish their cause without instrumented tool spans.","Request traces may be sampled; rates require a sampling multiplier."]
  };
}
// Seeded, session-dependent synthetic traffic for FleetScope closed-loop replay.
// Timings are illustrative, not modeled GPU predictions. Profile parameters are editable.
export function synthesize(type, { sessions=20, seed=1, start=0, overrides={} }={}) {
  const preset=PRESETS[type];
  if(!preset) throw new Error("unknown workload type: "+type);
  if(!Number.isInteger(sessions)||sessions<1||sessions>10000) throw new Error("sessions must be 1..10000");
  if(!Number.isInteger(seed)) throw new Error("seed must be integer");
  const p={...preset,...overrides};
  for(const k of ["calls","input","output","thinkS","e2eS","sessionSpacingS","ttftS"]) if(!finite(p[k])||p[k]<0) throw new Error("invalid "+k);
  if(!Number.isInteger(p.calls)||p.calls<1||p.calls>1000||p.input<1||p.output<1) throw new Error("invalid calls/input/output");
  if(!finite(p.cachedRatio)||p.cachedRatio<0||p.cachedRatio>1) throw new Error("cachedRatio must be 0..1");
  if(!finite(p.growth)||p.growth<0) throw new Error("growth must be nonnegative");
  let state=(seed>>>0)||1;
  const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
  const rows=[];
  for(let s=0;s<sessions;s++){
    let t=start+s*p.sessionSpacingS*(0.7+0.6*rand());
    for(let i=0;i<p.calls;i++){
      const isl=Math.max(1,Math.round(p.input*(1+p.growth*i)*(0.7+0.6*rand())));
      const osl=Math.max(1,Math.round(p.output*(0.7+0.6*rand())));
      const cached= i===0?0:Math.round(isl*p.cachedRatio*(0.85+0.15*rand()));
      const e2e=p.e2eS*(0.8+0.4*rand());
      rows.push({t:+t.toFixed(3),isl,osl,cached,ttft:+Math.min(e2e,p.ttftS).toFixed(3),e2e:+e2e.toFixed(3),session:"synthetic-"+s});
      t+=e2e+p.thinkS*(0.7+0.6*rand());
    }
  }
  return normalize(rows);
}
const csvField=v=>v==null?"":String(v).replace(/[\r\n",]/g,"_");
export function toFleetScopeCSV(rows,{ pseudonymize=true }={}) {
  const data=normalize(rows), labels=new Map();
  const head="timestamp,input_tokens,output_tokens,cached_tokens,ttft_s,queue_s,e2e_s,session";
  const out=[head];
  for(const r of data){
    let session="";
    if(r.session!=null){
      if(!labels.has(r.session))labels.set(r.session,"session-"+(labels.size+1));
      session=pseudonymize?labels.get(r.session):r.session;
    }
    out.push([r.t,r.isl,r.osl,r.cached??"",r.ttft??"","",r.e2e??"",csvField(session)].join(","));
  }
  return out.join("\n")+"\n";
}
