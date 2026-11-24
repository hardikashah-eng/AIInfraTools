import test from "node:test";
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {PRESETS,normalize,profile,synthesize,toFleetScopeCSV} from "../src/workloads.mjs";
const require=createRequire(import.meta.url);
const {parseTrace}=require("../../fleetscope/src/ingest.js");

test("all six deterministic workload presets produce closed-loop compatible replay",()=>{
  for(const type of Object.keys(PRESETS)){
    const a=synthesize(type,{sessions:3,seed:41});
    assert.deepEqual(a,synthesize(type,{sessions:3,seed:41}));
    assert.equal(a.length,3*PRESETS[type].calls);
    const csv=toFleetScopeCSV(a);
    const parsed=parseTrace(csv);
    assert.equal(parsed.trace.length,a.length);
    assert.equal(parsed.stats.sessions,3);
    assert.ok(parsed.trace.every(r=>r.isl>0&&r.osl>0&&r.cached>=0));
  }
});
test("reports measured percentiles and honest cache-coverage denominators",()=>{
  const rows=[
    {t:0,isl:100,osl:10,cached:50,e2e:2,session:"alice"},
    {t:10,isl:200,osl:20,e2e:4,session:"alice"},
    {t:22,isl:300,osl:30,cached:150,ttft:0.5,session:"bob"},
  ];
  const x=profile(rows,{type:"coding-agent"});
  assert.equal(x.requests,3);
  assert.equal(x.sessions,2);
  assert.equal(x.cache.coverage,2/3);
  assert.equal(x.cache.hitRatio,0.5);
  assert.equal(x.tokenDistributions.input.p50,200);
  assert.equal(x.session.observedIdleGapS.p50,8);
  assert.equal(x.latencyS.ttft.count,1);
});
test("pseudonymizes session ids and does not emit sensitive text",()=>{
  const rows=[{t:0,isl:10,osl:2,session:"employee@example.com",cached:0,prompt:"secret code"}];
  const csv=toFleetScopeCSV(rows);
  assert.ok(!csv.includes("employee@example.com"));
  assert.ok(!csv.includes("secret code"));
  assert.ok(csv.includes("session-1"));
});
test("invalid inputs and missing cache metrics are never silently converted into hits",()=>{
  assert.throws(()=>synthesize("unknown"));
  assert.throws(()=>synthesize("chat",{sessions:0}));
  assert.throws(()=>synthesize("chat",{overrides:{cachedRatio:2}}));
  const x=profile(normalize([{t:0,isl:20,osl:10}]));
  assert.equal(x.cache.coverage,0);
  assert.equal(x.cache.hitRatio,null);
});
