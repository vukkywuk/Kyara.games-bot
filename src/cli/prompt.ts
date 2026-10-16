import readline from 'node:readline/promises';
import { UsageError } from '../utils/errors.js';

/** Asks a yes/no question on the terminal. Returns false when stdin is not interactive. */
export async function confirmPrompt(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    process.stderr.write(`${question}\nNot an interactive terminal: refusing. Re-run with --yes to confirm explicitly.\n`);
    return false;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(`${question}\nProceed? Type "yes" to confirm: `)).trim().toLowerCase();
    return answer === 'yes' || answer === 'y';
  } finally {
    rl.close();
  }
}

/**
 * Reads a secret: hidden input on a terminal (nothing is echoed), or all of stdin when piped.
 * Either way the value never lands in shell history or on screen.
 */
export async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  process.stderr.write(prompt);
  return new Promise<string>((resolve, reject) => {
    let buf = '';
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stderr.write(`\n(${buf.length} characters received)\n`);
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          reject(new UsageError('Cancelled.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}
