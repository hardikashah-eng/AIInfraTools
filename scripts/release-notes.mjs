#!/usr/bin/env node
// Prints the release notes for a version: install lines, then that version's section of CHANGELOG.md with links made
// absolute (they render on the GitHub release page, not in the repository).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), REPO = 'https://github.com/hardikashah-eng/AIInfraTools';
export function notes(version, changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')) {
  const parts = changelog.split(/^## /m), sec = parts.find(p => p.startsWith(version + ' ') || p.startsWith(version + '\n'));
  if (!sec) throw new Error(`no "## ${version}" section in CHANGELOG.md`);
  const body = sec.split('\n').slice(1).join('\n').trim()
    .replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, p) => `](${REPO}/blob/main/${p.replace(/^\.\//, '')})`)
    .replace(/(^|[\s(–,])#(\d+)\b/g, `$1[#$2](${REPO}/pull/$2)`);
  return `**Install:** \`npx aiinfra-tools --help\` · **Try the loop:** \`npx aiinfra-tools demo\` · **In the browser:** https://hardikashah-eng.github.io/AIInfraTools/ · **MCP:** \`claude mcp add aiinfra -- npx -y aiinfra-tools mcp\`\n\n${body}\n`;
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(notes(process.argv[2] || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version));
