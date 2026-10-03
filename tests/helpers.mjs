// E2E テスト用ヘルパー
// CDN へのリクエストを node_modules/mermaid/dist へ差し替えるため、オフライン・CDN ブロック環境でも実行できる。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'node_modules/mermaid/dist');
const APP = process.env.MMD_APP || path.join(ROOT, 'index.html');  // 旧版との比較用に差し替え可能
export const ORIGIN = 'http://localhost:8123';

// Linux の Chromium はロケール未設定だと日本語のダウンロード名を "download" に置き換えるため UTF-8 を指定
process.env.LANG ||= 'C.UTF-8';

export async function launch() {
    return chromium.launch();
}

/**
 * @param {import('playwright').Browser} browser
 * @param {object} o
 *   cdn: 'ok' | 'fail' | 'hang' | 'hang-first'
 *   storage: 事前に localStorage へ入れる値
 *   init: 追加の初期化スクリプト
 */
export async function open(browser, o = {}) {
    const { hash = '', storage = null, cdn = 'ok', viewport = { width: 1400, height: 900 }, colorScheme = 'light', init = null, context = null } = o;
    const ctx = context || await browser.newContext({ viewport, colorScheme, acceptDownloads: true, permissions: ['clipboard-read', 'clipboard-write'] });
    if (!context) {
        await ctx.route(/cdn\.jsdelivr\.net|unpkg\.com|esm\.sh/, async route => {
            const url = route.request().url();
            if (cdn === 'fail') return route.abort();
            if (cdn === 'hang') return;   // 応答しない
            if (cdn === 'hang-first' && url.includes('cdn.jsdelivr.net')) return;
            const m = new URL(url).pathname.match(/\/dist\/(.+)$/);
            const f = m && path.join(DIST, m[1]);
            if (!f || !fs.existsSync(f)) return route.abort();
            route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' } });
        });
        await ctx.route(ORIGIN + '/**', route => route.fulfill({ status: 200, body: fs.readFileSync(APP), headers: { 'content-type': 'text/html; charset=utf-8' } }));
        if (storage) {
            await ctx.addInitScript(s => {
                if (sessionStorage.getItem('__seeded')) return;
                for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
                sessionStorage.setItem('__seeded', '1');
            }, storage);
        }
        if (init) await ctx.addInitScript(init);
    }
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    page.on('dialog', d => (page.onDialog ? page.onDialog(d) : d.accept()));
    await page.goto(ORIGIN + '/index.html' + hash);
    return page;
}

export async function ready(page, timeout = 20000) {
    await page.waitForFunction(() => {
        const pill = document.getElementById('statusPill');
        const text = document.getElementById('statusText').textContent;
        return pill && !pill.classList.contains('busy') && !/準備中|読込中|時間がかかって/.test(text) &&
            !document.getElementById('spinner').classList.contains('show');
    }, null, { timeout });
}

// 入力 → デバウンス → 描画完了まで待つ
export async function settle(page, ms = 900) {
    await page.waitForTimeout(ms);
    await page.waitForFunction(() => !document.getElementById('spinner').classList.contains('show'), null, { timeout: 30000 });
}

export async function setCode(page, src) {
    await page.evaluate(s => {
        const c = document.getElementById('code');
        c.value = s;
        c.dispatchEvent(new Event('input', { bubbles: true }));
    }, src);
}

export async function renderNow(page, src) {
    if (src !== undefined) await setCode(page, src);
    await page.click('#renderBtn');
    await settle(page, 300);
}

export const ui = page => page.evaluate(() => ({
    status: document.getElementById('statusText').textContent,
    error: document.getElementById('error').classList.contains('show') ? document.getElementById('error').textContent : '',
    warn: document.getElementById('warn').classList.contains('show') ? document.getElementById('warn').textContent : '',
    svg: !!document.querySelector('#mermaidOutput svg'),
    stale: document.getElementById('mermaidOutput').classList.contains('stale'),
    errLine: Number(document.querySelector('#gutter .err')?.textContent || 0),
    zoom: document.getElementById('zoomLevel').textContent,
    docs: [...document.getElementById('docSelect').options].map(o => o.textContent),
    current: document.getElementById('docSelect').selectedOptions[0]?.textContent,
    code: document.getElementById('code').value,
    toasts: document.getElementById('toastHost').textContent,
    exportDisabled: document.getElementById('pngBtn').disabled
}));

export async function download(page, selector) {
    const [d] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click(selector)]);
    const file = await d.path();
    return { name: d.suggestedFilename(), bytes: fs.readFileSync(file) };
}
