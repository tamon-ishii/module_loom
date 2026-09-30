import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// Explicit opt-in: AI calls use the selected CLI account; native runs open a window.
const [mode, target] = process.argv.slice(2);
assert.ok(['--ai', '--native'].includes(mode) && target, 'Usage: node scripts/smoke_manual_integrations.mjs --ai AGENT | --native BINARY');
const execute = promisify(execFile);
const root = await mkdtemp(path.join(os.tmpdir(), 'manual-integration-smoke-'));
const executable = name => process.platform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name;
const cli = path.resolve(executable('target/debug/manualctl'));
let app;
try {
  await mkdir(path.join(root, 'docs'));
  const request = async (action, options = {}) => {
    const { stdout } = await execute(cli, ['--request', JSON.stringify({ root, action, options })], {
      timeout: mode === '--native' ? 30_000 : 180_000, maxBuffer: 2_000_000,
    });
    return stdout.trim();
  };
  if (mode === '--ai') {
    await writeFile(path.join(root, 'index.html'), '<button id="save-guide">原稿を保存</button>');
    await writeFile(path.join(root, 'docs/index.md'), '<!-- ai:task id=save-guide kind=text\nindex.htmlのボタンについて日本語で一文だけ説明してください。ソースを確認し、ai:factコメントに根拠を記録してください。\n-->\n');
    await request('save', { agent: target });
    await request('generate-task', { id: 'save-guide' });
    const content = await readFile(path.join(root, 'docs/index.md'), 'utf8');
    assert.match(content, /ai:generated/);
    assert.match(content, /原稿を保存/);
    assert.match(content, /ai:fact/);
    const report = JSON.parse(await request('fact-check', { check: true }));
    console.log(`AI integration passed (${target}): generated Markdown with verified source evidence.`);
    console.log(JSON.stringify(report));
  } else {
    await writeFile(path.join(root, 'docs/index.md'), '<!-- ai:task id=studio-window kind=screenshot\nManual Studioウィンドウを撮影する。\n-->\n');
    const launch = async () => {
      app = spawn(path.resolve(executable(target)), [], { stdio: ['ignore', 'ignore', 'pipe'] });
      let startupError = '';
      let failed = false;
      app.stderr.on('data', chunk => { startupError += chunk.toString(); });
      app.on('error', error => { failed = true; startupError += error.message; });
      for (let attempt = 0; attempt < 30; attempt++) {
        const windows = JSON.parse(await request('list-windows'));
        const matches = windows.filter(item => item.title === 'Manual Studio');
        assert.ok(matches.length <= 1, 'Close other Manual Studio windows before running this test.');
        if (matches.length === 1) return matches[0];
        if (failed || app.exitCode !== null) break;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error(`Packaged application window did not appear: ${startupError}`);
    };
    const window = await launch();
    await request('capture-window', { id: 'studio-window', window: window.id, inset: '0' });
    const exited = new Promise(resolve => app.once('exit', resolve));
    app.kill('SIGTERM');
    await exited;
    await launch();
    await request('recapture', { id: 'studio-window' });
    const image = await readFile(path.join(root, 'docs/assets/studio-window.png'));
    assert.equal(image.subarray(1, 4).toString(), 'PNG');
    assert.ok(image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0);
    const sources = JSON.parse(await readFile(path.join(root, 'manual/capture_sources.json'), 'utf8'));
    assert.equal(sources['studio-window'].title, 'Manual Studio');
    assert.equal('id' in sources['studio-window'], false);
    console.log(`Native integration passed (${process.platform}): application launch, window capture, saved-source recapture after restart.`);
  }
} finally {
  if (app?.pid && app.exitCode === null) {
    const exited = new Promise(resolve => app.once('exit', resolve));
    app.kill('SIGTERM');
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
