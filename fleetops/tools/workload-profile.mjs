#!/usr/bin/env node
// Workload profile CLI. Reuses FleetScope ingest for CSV, LiteLLM, OpenAI, Anthropic and OTLP.
import fs from "node:fs";
import path from "node:path";
import {createRequire} from "node:module";
import {openStore} from "../src/store.mjs";
import {PRESETS,normalize,profile,synthesize,toFleetScopeCSV} from "../src/workloads.mjs";
const require=createRequire(import.meta.url);
const {parseTrace}=require("../../fleetscope/src/ingest.js");
const args=process.argv.slice(2), cmd=args[0]||"help";
function opt(name,fallback){const i=args.indexOf("--"+name);return i<0?fallback:args[i+1];}
function save(out,data){if(!out)throw new Error("--out is required");fs.mkdirSync(path.dirname(path.resolve(out)),{recursive:true});fs.writeFileSync(out,data);}
function readInput(file) {
  // Offset limit permits normal trace windows beyond FleetScope's browser truncation.
  const parsed=parseTrace(fs.readFileSync(file,"utf8"),{maxRows:1000000,maxSeconds:Number.MAX_SAFE_INTEGER});
  return {rows:parsed.trace,notes:parsed.notes,format:parsed.format};
}
async function main(){
  if(cmd==="list"){console.log(JSON.stringify(PRESETS,null,2));return;}
  if(cmd==="synth"){
    const type=opt("type","coding-agent"), sessions=Number(opt("sessions","20")),seed=Number(opt("seed","1"));
    const rows=synthesize(type,{sessions,seed});
    const csv=toFleetScopeCSV(rows);
    if(opt("out"))save(opt("out"),csv); else process.stdout.write(csv);
    if(opt("summary"))save(opt("summary"),JSON.stringify(profile(rows,{type,source:"synthetic"}),null,2)+"\n");
    return;
  }
  if(cmd==="inspect"){
    const input=opt("input"),dir=opt("store");
    if(!input&&!dir)throw new Error("provide --input TRACE or --store DIRECTORY");
    if(input&&dir)throw new Error("choose only one of --input and --store");
    let rows,source,notes=[];
    if(input){const parsed=readInput(input);rows=parsed.rows;source=parsed.format;notes=parsed.notes;}
    else {
      const store=await openStore(dir);
      const from=opt("from"),to=opt("to"),pool=opt("pool");
      const data=store.query("request",{from:from==null?undefined:Number(from),to:to==null?undefined:Number(to),where:pool?r=>r.pool===pool:undefined});
      rows=data.map(r=>({t:r.t,isl:r.isl,osl:r.osl,cached:r.cached,ttft:r.ttft,e2e:r.e2e,session:r.session||r.session_id||r.conversation_id}));
      source="fleetops-store";
    }
    rows=normalize(rows);
    const type=opt("type","unknown");
    const result={...profile(rows,{type,source}),notes};
    if(opt("out"))save(opt("out"),JSON.stringify(result,null,2)+"\n");
    else console.log(JSON.stringify(result,null,2));
    if(opt("csv"))save(opt("csv"),toFleetScopeCSV(rows));
    return;
  }
  console.log("Usage:\n  node tools/workload-profile.mjs list\n  node tools/workload-profile.mjs synth --type coding-agent|chat|report-generation|rag-search|deep-research|autocomplete --sessions 20 --seed 1 --out replay.csv [--summary profile.json]\n  node tools/workload-profile.mjs inspect --input trace.jsonl --type coding-agent [--out profile.json] [--csv replay.csv]\n  node tools/workload-profile.mjs inspect --store fleet-data [--pool chat] [--from EPOCH] [--to EPOCH] [--out profile.json] [--csv replay.csv]");
}
main().catch(e=>{console.error("workload-profile: "+e.message);process.exitCode=1;});
