import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'cli', 'super-ask.py');
const PORT = process.env.SUPER_ASK_PORT ?? '19960';

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [CLI, ...args], {
      cwd: join(HERE, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

test('poll exposes not_found as structured status', async () => {
  const missingSessionId = '00000000-0000-0000-0000-000000000000';
  const result = await runCli([
    '--poll',
    '--session-id',
    missingSessionId,
    '--poll-interval',
    '1',
    '--poll-timeout',
    '1',
    '--port',
    PORT,
  ]);

  assert.equal(result.code, 3);
  assert.equal(result.stderr.trim(), '');

  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'not_found');
  assert.equal(payload.chatSessionId, missingSessionId);
});
