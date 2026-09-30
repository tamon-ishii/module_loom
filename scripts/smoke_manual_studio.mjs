import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

// Run against `npm run manual:dev` after building manualctl.
const base = process.env.MANUAL_STUDIO_URL || 'http://127.0.0.1:5174';
const root = await mkdtemp(path.join(os.tmpdir(), 'manual-studio-smoke-'));
let browser;
let server;
try {
  if (process.argv.includes('--start-server')) {
    server = spawn(process.execPath, [path.resolve('node_modules/vite/bin/vite.js'), '--config', 'apps/manual-studio/vite.config.ts'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let diagnostics = '';
    let failed = false;
    server.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); });
    server.on('error', error => { failed = true; diagnostics += error.message; });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failed || server.exitCode !== null) throw new Error(`Development server failed: ${diagnostics}`);
      try { ready = (await fetch(base)).ok; } catch { /* Server is still starting. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `Development server did not start: ${diagnostics}`);
  }
  await mkdir(path.join(root, 'docs'));
  await mkdir(path.join(root, 'empty'));
  await writeFile(path.join(root, 'docs/index.md'), '# Smoke guide\n\nOriginal text\n');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const idle = async (target = page) => {
    await target.waitForFunction(() => document.body.getAttribute('aria-busy') === 'false');
  };
  await page.goto(`${base}/?root=${encodeURIComponent(root)}`);
  await page.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Original text'));
  await idle();
  await page.locator('#markdown-editor').fill('# Edited guide\n\n**Saved content**\n');
  await page.locator('#save-page').click();
  await idle();
  assert.match(await readFile(path.join(root, 'docs/index.md'), 'utf8'), /Saved content/);
  await page.frameLocator('#markdown-preview').locator('strong').waitFor();

  const popupPromise = page.waitForEvent('popup');
  await page.locator('#detach-editor').click();
  const popup = await popupPromise;
  await popup.waitForFunction(() => document.querySelector('#markdown-editor').value.includes('Saved content'));
  await idle(popup);
  await popup.locator('#markdown-editor').fill('# Updated in another window\n');
  await popup.locator('#save-page').click();
  await idle(popup);
  await page.locator('#markdown-editor').fill('# Stale edit\n');
  await page.locator('#save-page').click();
  await idle();
  assert.match(await page.locator('#status').innerText(), /原稿が更新/);
  assert.equal(await readFile(path.join(root, 'docs/index.md'), 'utf8'), '# Updated in another window\n');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#reload-page').click();
  await idle();
  assert.equal(await page.locator('#markdown-editor').inputValue(), '# Updated in another window\n');
  await popup.close();

  await page.locator('#project-root').fill(path.join(root, 'empty'));
  await page.locator('#project-form button[type=submit]').click();
  await idle();
  assert.equal(await page.locator('#markdown-editor').inputValue(), '');
  assert.equal(await page.locator('#markdown-editor').isDisabled(), true);
  assert.equal(await page.locator('#editor-title').innerText(), 'Markdownを編集する');
  assert.equal(await page.locator('#markdown-preview').getAttribute('srcdoc'), '');

  await page.locator('#new-page').click();
  await page.locator('#new-page-path').fill('new.md');
  await page.locator('#new-page-title').fill('New guide');
  await page.locator('#new-page-form button[type=submit]').click();
  await idle();
  assert.match(await readFile(path.join(root, 'empty/docs/new.md'), 'utf8'), /# New guide/);
  const project = path.join(root, 'empty');
  await symlink(path.resolve('node_modules'), path.join(project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(project, 'screen.html'), '<h1>Capture target</h1><button>Continue</button>');
  await page.locator('[data-insert="screenshot"]').click();
  await page.locator('#save-page').click();
  await idle();
  const task = 'task-new-screenshot-1';
  await page.locator('[data-tab="scenarios"]').click();
  await page.locator('#scenario-path').fill('manual/scenarios/smoke.json');
  await page.locator('#scenario-json').fill(JSON.stringify({
    version: 1, platform: 'web', base_url: pathToFileURL(path.join(project, 'screen.html')).href,
    steps: [{ goto: './screen.html' }, { expect_visible: 'button' }, { screenshot: { task } }],
  }));
  await page.locator('#scenario-save').click();
  await idle();
  assert.equal(await page.locator('#status').evaluate(node => node.classList.contains('error')), false);
  await page.locator('#scenario-bind').click();
  await idle();
  assert.equal(JSON.parse(await readFile(path.join(project, 'manual/capture_sources.json'), 'utf8'))[task].kind, 'scenario');
  await page.locator('[data-tab="tasks"]').click();
  await page.locator(`[data-recapture="${task}"]`).click();
  await idle();
  assert.equal(await page.locator('#status').evaluate(node => node.classList.contains('error')), false);
  const image = await readFile(path.join(project, `docs/assets/${task}.png`));
  assert.equal(image.subarray(1, 4).toString(), 'PNG');
  assert.match(await readFile(path.join(project, 'docs/new.md'), 'utf8'), /ai:generated/);
  await page.locator('[data-tab="publish"]').click();
  await page.locator('#build-draft').click();
  await idle();
  assert.equal(await page.locator('#status').evaluate(node => node.classList.contains('error')), false);
  const buildResult = await page.locator('#publish-result').innerText();
  if (process.env.MANUAL_STUDIO_REQUIRE_HTML === '1') assert.match(buildResult, /Site:/);
  if (buildResult.includes('Site:')) {
    assert.match(await readFile(path.join(project, 'manual/new.html'), 'utf8'), /New guide/);
  } else {
    assert.match(buildResult, /MkDocs site build skipped/);
  }
  assert.deepEqual(errors, []);
  console.log(`Manual Studio smoke passed: edit, preview, save, detached conflict, project switch, new page, saved scenario recapture, ${buildResult.includes('Site:') ? 'HTML build' : 'missing MkDocs message'}.`);
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
