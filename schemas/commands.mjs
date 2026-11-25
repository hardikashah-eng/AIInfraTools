// The --json commands that agents and scripts depend on, each with the demo data it runs on. scripts/schemas.mjs
// runs them to write or check schemas/<id>.schema.json. A command's setup returns what its args need.
import path from 'node:path';

export const COMMANDS = [
  { id: 'sizer.list', usage: '--list', tool: 'sizer', args: () => ['--list', '--json'] },
  { id: 'sizer.plan', usage: '--model M --gpu G', tool: 'sizer', args: () => ['--model', 'llama33-70b', '--gpu', 'H100', '--json'],
    more: [['--model', 'deepseek-v3', '--gpu', 'B200', '--json'], ['--model', 'llama31-8b', '--gpu', 'L40S', '--json']] },
  { id: 'sizer.compare', usage: '--model M --compare G1,G2,…', tool: 'sizer', args: () => ['--model', 'llama33-70b', '--compare', 'B200,H200,H100,MI300X', '--json'] },
  { id: 'fleetscope.templates', usage: 'templates', tool: 'fleetscope', args: () => ['templates', '--json'] },
  { id: 'fleetscope.run', usage: 'run --template T', tool: 'fleetscope', args: () => ['run', '--template', 'burst', '--json'], more: [['run', '--template', 'xpd', '--json']] },
  { id: 'fleetscope.ask', usage: 'ask "QUESTION" --template T', tool: 'fleetscope', args: c => ['ask', 'What if the cloud link drops to 25 Gbps and traffic doubles?', '--template', 'xpd', '--json', '-o', path.join(c.dir, 'edited.json')] },
  { id: 'gpu-health.analyze', usage: 'analyze --samples F --jobs F --state DIR', tool: 'gpu-health',
    setup: c => [['gpu-health', 'demo', '--out', path.join(c.dir, 'g')]],
    args: c => ['analyze', '--samples', path.join(c.dir, 'g/data/samples.jsonl'), '--jobs', path.join(c.dir, 'g/data/jobs.json'), '--state', path.join(c.dir, 'gs'), '--json'] },
  { id: 'gpu-health.flakiness', usage: 'flakiness --state DIR', tool: 'gpu-health', setup: c => [['gpu-health', 'demo', '--out', path.join(c.dir, 'g')]], args: c => ['flakiness', '--state', path.join(c.dir, 'g/state'), '--json'] },
  { id: 'ledger.report', usage: 'report --usage F --config F --format json', tool: 'ledger', setup: c => [['ledger', 'demo', '--out', path.join(c.dir, 'l')]],
    args: c => ['report', '--usage', path.join(c.dir, 'l/usage.jsonl'), '--config', path.join(c.dir, 'l/ledger.json'), '--by', 'org,team', '--format', 'json'] },
  { id: 'ledger.insights', usage: 'insights --usage F --config F', tool: 'ledger', setup: c => [['ledger', 'demo', '--out', path.join(c.dir, 'l')]],
    args: c => ['insights', '--usage', path.join(c.dir, 'l/usage.jsonl'), '--config', path.join(c.dir, 'l/ledger.json'), '--json'] },
  { id: 'fleetops.rca.diagnose', usage: 'rca diagnose --symptom S --from T --to T', tool: 'fleetops', setup: c => [['fleetops', 'demo', '--store', path.join(c.dir, 'f'), '--json']],
    args: (c, s) => { const i = s[0].demo.incident; return ['rca', 'diagnose', '--symptom', i.symptom, '--from', String(i.from), '--to', String(i.to), '--store', path.join(c.dir, 'f'), '--json']; } },
  { id: 'fleetops.serving.fit', usage: 'serving fit --gpu G --nodes N …', tool: 'fleetops', args: () => ['serving', 'fit', '--gpu', 'H100', '--nodes', '2', '--isl', '2000', '--osl', '400', '--ttft', '2', '--tpot', '0.05', '--json'] },
  { id: 'fleetops.serving.capacity', usage: 'serving capacity --model M --gpu G --nodes N …', tool: 'fleetops', args: () => ['serving', 'capacity', '--model', 'llama33-70b', '--gpu', 'H100', '--nodes', '2', '--isl', '2000', '--osl', '400', '--ttft', '2', '--tpot', '0.05', '--json'] },
  { id: 'fleetops.power.report', usage: 'power report --budgets F --from T --to T', tool: 'fleetops', setup: c => [['fleetops', 'power', 'demo', '--store', path.join(c.dir, 'p'), '--json']],
    args: (c, s) => ['power', 'report', '--budgets', s[0].demo.budgets, '--from', String(s[0].demo.from), '--to', String(s[0].demo.to), '--store', path.join(c.dir, 'p'), '--json'] },
  { id: 'fleetops.power.plan', usage: 'power plan --budgets F --from T --to T', tool: 'fleetops', setup: c => [['fleetops', 'power', 'demo', '--store', path.join(c.dir, 'p'), '--json']],
    args: (c, s) => ['power', 'plan', '--budgets', s[0].demo.budgets, '--from', String(s[0].demo.from), '--to', String(s[0].demo.to), '--store', path.join(c.dir, 'p'), '--out', path.join(c.dir, 'plan.json'), '--json'] },
  { id: 'fix-skew.demo', usage: '--demo', tool: 'fix-skew', args: () => ['--demo', '--json'] },
];
