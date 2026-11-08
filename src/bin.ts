#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { main } from './cli.js';

const controller = new AbortController();
let interrupts = 0;
const interrupt = (): void => {
  interrupts += 1;
  if (interrupts > 1) process.exit(130);
  process.stderr.write('\nStopping. Before the run nothing is spent, and a running run gets cancelled. Press Ctrl-C again to quit at once.\n');
  controller.abort();
};
process.on('SIGINT', interrupt);

const prompt = async (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on('SIGINT', interrupt);
  try {
    return await rl.question(question, { signal: controller.signal });
  } catch {
    return '';
  } finally {
    rl.close();
  }
};

main(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  interactive: Boolean(process.stdin.isTTY),
  prompt,
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  exists: (path) => existsSync(path),
  signal: controller.signal,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  },
);
