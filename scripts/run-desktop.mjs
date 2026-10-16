// Starts the built desktop app. Editors built on Electron (VS Code) set ELECTRON_RUN_AS_NODE in
// their terminals, which would make Electron run as plain Node: it is removed for the child.
import { spawn } from 'node:child_process';
import electron from 'electron';

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['desktop/app', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
