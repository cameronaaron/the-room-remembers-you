import { execFileSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_LABEL, launchAgentPlist } from './autostart-plist.ts';

const project = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDirectory = join(homedir(), 'Library', 'LaunchAgents');
const plist = join(agentDirectory, `${AGENT_LABEL}.plist`);
const runtime = join(project, '.runtime');

await mkdir(agentDirectory, { recursive: true });
await mkdir(runtime, { recursive: true });
await writeFile(plist, launchAgentPlist({ project, runtime }), { mode: 0o644 });
await chmod(plist, 0o644);
execFileSync('plutil', ['-lint', plist], { stdio: 'inherit' });
const domain = `gui/${process.getuid()}`;
try { execFileSync('launchctl', ['bootout', domain, plist], { stdio: 'ignore' }); } catch {}
execFileSync('launchctl', ['bootstrap', domain, plist], { stdio: 'inherit' });
console.log(`Installed automatic gallery startup: ${plist}`);
