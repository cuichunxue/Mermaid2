// 破壊テスト兼リグレッションテスト。各テストは分析で見つかった不具合（docs/ANALYSIS.md の ID）に対応する。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { launch, open, ready, settle, setCode, renderNow, ui, download } from './helpers.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

async function withPage(opts, fn) {
    const page = await open(browser, opts);
    try { await fn(page); }
    finally { await page.context().close(); }
    assert.deepEqual(page.errors, [], 'ページで未捕捉の例外が発生した');
}

/* ---------------- 起動・耐障害性 ---------------- */

test('B01 壊れた保存データ（null要素・欠損フィールド）でも起動する', () => withPage({
    storage: { mermaid_docs: JSON.stringify([null, 5, { id: 'x' }, { id: 'y', name: 7, code: 'graph TD\n A-->B' }]), mermaid_current: 'y' }
}, async page => {
    await ready(page);
    const s = await ui(page);
    assert.ok(s.svg, '図が描画される');
    assert.deepEqual(s.docs, ['無題', '7']);
}));

test('B02 localStorage が使えない環境でも編集・描画できる', () => withPage({
    init: () => {
        for (const m of ['getItem', 'setItem', 'removeItem']) Storage.prototype[m] = () => { throw new DOMException('denied', 'SecurityError'); };
    }
}, async page => {
    await ready(page);
    assert.match((await ui(page)).toasts, /保存領域が使えません/);
    await renderNow(page, 'graph LR\n X-->Y');
    assert.ok((await ui(page)).svg);
}));

test('B03 CDN が全滅してもエディタは使え、再試行できる', () => withPage({
    cdn: 'fail', storage: { mermaid_docs: JSON.stringify([{ id: 'a', name: '保存済み', code: 'graph TD\n SAVED-->X', updated: 1 }]) }
}, async page => {
    await page.waitForSelector('#loadFail.show', { timeout: 15000 });
    const s = await ui(page);
    assert.match(s.code, /SAVED/, '保存済みコードが表示される');
    assert.equal(s.status, 'ライブラリ読込失敗');
    await page.click('#code');
    await page.keyboard.type('X');
    assert.ok(await page.isVisible('#retryLoadBtn'));
}));

test('B04 最初の CDN が無応答でも次の CDN へヘッジして読み込む', () => withPage({ cdn: 'hang-first' }, async page => {
    const t = Date.now();
    await ready(page, 15000);
    assert.ok((await ui(page)).svg);
    assert.ok(Date.now() - t < 12000, '旧実装は 12 秒待ってから次を試していた');
}));

/* ---------------- エラー行 ---------------- */

const LINE_CASES = [
    ['先頭の空行', '\n\n\ngraph TD\n  A-->B\n  B-->>>C', 6],
    ['frontmatter', '---\ntitle: x\n---\ngraph TD\n A-->B\n B-->>>C', 6],
    ['init ディレクティブ', '%%{init: {"theme":"forest"}}%%\ngraph TD\n A-->B\n B-->>>C', 4],
    ['コメント行', 'graph TD\n%% c1\n\n%% c2\n A-->B\n B-->>>C', 6],
    ['langium 系(pie) + frontmatter', '---\ntitle: x\n---\npie\n "a": 1\n "b" 2', 6]
];
for (const [name, src, want] of LINE_CASES) {
    test(`B05 エラー行番号が元のコードの行を指す: ${name}`, () => withPage({}, async page => {
        await ready(page);
        await renderNow(page, src);
        const s = await ui(page);
        assert.equal(s.errLine, want);
        assert.match(s.status, new RegExp(`${want}行目`));
        assert.match(s.error, new RegExp(`line ${want}`), 'mermaid の文言も補正される');
    }));
}

/* ---------------- エディタ操作 ---------------- */

test('B06 Tab/Shift+Tab/コメント切替が undo 可能で、Esc→Tab でフォーカスを抜けられる', () => withPage({}, async page => {
    await ready(page);
    await setCode(page, 'graph TD\nA-->B\nB-->C');
    await page.click('#code');
    await page.evaluate(() => { const c = document.getElementById('code'); c.setSelectionRange(9, c.value.length); });
    await page.keyboard.press('Tab');
    assert.equal((await ui(page)).code, 'graph TD\n    A-->B\n    B-->C');
    await page.keyboard.press('Shift+Tab');
    assert.equal((await ui(page)).code, 'graph TD\nA-->B\nB-->C');
    await page.keyboard.press('Control+/');
    assert.equal((await ui(page)).code, 'graph TD\n%% A-->B\n%% B-->C');
    await page.keyboard.press('Control+z');
    assert.equal((await ui(page)).code, 'graph TD\nA-->B\nB-->C', 'undo で戻る');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'code', 'キーボードトラップしない');
}));

test('B07 テンプレート置換は Ctrl+Z で元に戻せる', () => withPage({}, async page => {
    await ready(page);
    await setCode(page, 'graph TD\n MINE-->X');
    await page.selectOption('#templateSelect', 'pie');
    assert.match((await ui(page)).code, /^pie/);
    await page.keyboard.press('Control+z');
    assert.equal((await ui(page)).code, 'graph TD\n MINE-->X');
}));

/* ---------------- 描画・書き出し ---------------- */

test('B08 全テンプレートが描画でき PNG 書き出しに成功する（journey を含む）', () => withPage({}, async page => {
    await ready(page);
    const keys = await page.evaluate(() => [...document.querySelectorAll('#templateSelect option')].map(o => o.value).filter(Boolean));
    assert.ok(keys.length >= 12);
    for (const k of keys) {
        await page.selectOption('#templateSelect', k);
        await settle(page, 200);
        const s = await ui(page);
        assert.ok(s.svg && !s.error, `${k} が描画される: ${s.error}`);
        const png = await download(page, '#pngBtn');
        assert.equal(png.bytes.subarray(1, 4).toString(), 'PNG', `${k} の PNG`);
        assert.ok(png.bytes.length > 2000, `${k} の PNG が空でない`);
    }
}));

test('B09 HTMLラベル（foreignObject）を含む図でも PNG 書き出しが失敗しない', () => withPage({}, async page => {
    await ready(page);
    await renderNow(page, 'graph TD\n A[ラベル] --> B');
    // 図内設定や将来の mermaid の変更で foreignObject が混ざった状況を再現（canvas 汚染で toBlob が失敗するケース）
    await page.evaluate(() => {
        const svg = document.querySelector('#mermaidOutput svg');
        const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
        fo.setAttribute('x', 0); fo.setAttribute('y', 0); fo.setAttribute('width', 120); fo.setAttribute('height', 40);
        fo.innerHTML = '<div xmlns="http://www.w3.org/1999/xhtml" style="font-size:14px;color:#123456"><span>HTML<br>ラベル</span></div>';
        svg.appendChild(fo);
    });
    const png = await download(page, '#pngBtn');
    assert.equal(png.bytes.subarray(1, 4).toString(), 'PNG');
    const svg = await download(page, '#svgBtn');
    assert.match(svg.bytes.toString(), /foreignObject/, 'SVG 書き出しは HTML ラベルを保持する');
}));

test('B10 ダークテーマで図の背景が暗く、PNG も暗い背景になる', () => withPage({ colorScheme: 'dark' }, async page => {
    await ready(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'OS 設定に追従');
    const bg = await page.evaluate(() => getComputedStyle(document.getElementById('mermaidOutput')).backgroundColor);
    assert.equal(bg, 'rgb(51, 51, 51)');
    const png = await download(page, '#pngBtn');
    const px = await page.evaluate(async b64 => {
        const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0); return [...x.getImageData(1, 1, 1, 1).data];
    }, png.bytes.toString('base64'));
    assert.ok(px[0] < 80 && px[1] < 80 && px[2] < 80, `PNG の背景が暗い: ${px}`);
    const svg = await download(page, '#svgBtn');
    assert.match(svg.bytes.toString(), /<rect[^>]+fill="#333333"/, 'SVG にも背景を敷く');
}));

test('B11 描画中にドキュメントを切り替えても正しい図が表示される', () => withPage({}, async page => {
    await ready(page);
    await page.click('#newDocBtn');
    await setCode(page, 'sequenceDiagram\n A->>B: hi');
    await page.click('#renderBtn');
    await page.selectOption('#docSelect', { index: 0 });
    await settle(page, 1200);
    const s = await ui(page);
    assert.equal(s.error, '');
    assert.ok(await page.evaluate(() => !!document.querySelector('#mermaidOutput svg .node')), 'フローチャートが表示される');
}));

test('B12 手動ズームは編集で失われず、全体表示で自動追従に戻る', () => withPage({}, async page => {
    await ready(page);
    await page.click('#zoomIn'); await page.click('#zoomIn');
    const z = (await ui(page)).zoom;
    await page.click('#code'); await page.keyboard.press('Control+End'); await page.keyboard.type('\nE-->F');
    await settle(page, 1200);
    assert.equal((await ui(page)).zoom, z);
    await page.click('#zoomFit');
    assert.notEqual((await ui(page)).zoom, z);
}));

test('B13 構文エラー時は前回の図を薄く残し、書き出しを無効化する', () => withPage({}, async page => {
    await ready(page);
    await renderNow(page, 'graph TD\n A-->>>B');
    const s = await ui(page);
    assert.ok(s.svg && s.stale && s.exportDisabled);
    await renderNow(page, 'graph TD\n A-->B');
    const t = await ui(page);
    assert.ok(!t.stale && !t.exportDisabled);
}));

test('B14 辺が 500 を超える図も描画できる（mermaid 既定上限の引き上げ）', () => withPage({}, async page => {
    await ready(page);
    let s = 'graph LR\n';
    for (let i = 0; i < 600; i++) s += `a${i % 50}-->b${i}\n`;
    await renderNow(page, s);
    assert.equal((await ui(page)).error, '');
}));

test('B15 XSS: ラベル・click・init ディレクティブ経由でスクリプトが実行されない', () => withPage({}, async page => {
    await ready(page);
    let pwned = false;
    await page.exposeFunction('pwned', () => { pwned = true; });
    await renderNow(page, '%%{init: {"securityLevel":"loose"}}%%\ngraph TD\n A["<img src=x onerror=window.pwned()>"] --> B["<script>window.pwned()</script>"]\n click A href "javascript:window.pwned()"\n click B call pwned()');
    await page.click('#mermaidOutput svg g.node >> nth=0').catch(() => {});
    await page.waitForTimeout(300);
    assert.equal(pwned, false);
    assert.doesNotMatch(await page.innerHTML('#mermaidOutput'), /onerror=|javascript:|<script/i);
}));

/* ---------------- ジャーニー図 ---------------- */

test('J01 ジャーニー図: 黙って誤描画される記述を警告する', () => withPage({}, async page => {
    await ready(page);
    await renderNow(page, [
        'journey', '  title T', '  section 朝',
        '    起床: 5: 私',               // 2..4 正常
        '    時刻 10:00 出発: 3: 私',      // 5 半角コロン
        '    朝食: 7: 私',                // 6 範囲外
        '    昼食: 3.5: 私',              // 7 小数
        '    移動: 3',                    // 8 アクターなし
        '    とても長いタスク名とても長いタスク名: 3: 私'  // 9 長い
    ].join('\n'));
    const s = await ui(page);
    assert.ok(s.svg && !s.error, 'mermaid 自体はエラーにしない');
    assert.match(s.warn, /5行目.*半角「:」/);
    assert.match(s.warn, /6行目.*スコア「7」/);
    assert.match(s.warn, /7行目.*スコア「3.5」/);
    assert.match(s.warn, /8行目.*アクター/);
    assert.match(s.warn, /9行目.*<br>/);
    assert.doesNotMatch(s.warn, /4行目/, '正常な行は警告しない');
}));

test('J02 ジャーニー図: 正しい記述では警告が出ず、タスク名・セクション名が読める色で描画される', () => withPage({}, async page => {
    await ready(page);
    await page.selectOption('#templateSelect', 'journey');
    await settle(page, 300);
    const s = await ui(page);
    assert.equal(s.warn, '');
    const fills = await page.evaluate(() => [...document.querySelectorAll('#mermaidOutput text.task, #mermaidOutput text.journey-section')]
        .map(t => getComputedStyle(t).fill));
    assert.ok(fills.length >= 12);
    for (const f of fills) assert.equal(f, 'rgb(31, 35, 40)', 'タスク名が背景に溶けない');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#mermaidOutput foreignObject').length), 0);
}));

test('J03 ジャーニー図: アクターが 10 人を超えると色の重複を警告する', () => withPage({}, async page => {
    await ready(page);
    const actors = Array.from({ length: 12 }, (_, i) => 'A' + i).join(', ');
    await renderNow(page, `journey\n section S\n  t: 3: ${actors}`);
    assert.match((await ui(page)).warn, /12 人/);
}));

/* ---------------- データ保全 ---------------- */

test('D01 保存容量超過を利用者に通知する（旧実装は無言で消失）', () => withPage({
    storage: { mermaid_docs: JSON.stringify([
        { id: 'big', name: '大きい', code: 'graph TD\n%%' + 'x'.repeat(4.9e6), updated: 1 },
        { id: 'cur', name: '作業中', code: 'graph TD\n A-->B', updated: 1 }
    ]), mermaid_current: 'cur' }
}, async page => {
    await ready(page);
    await setCode(page, 'graph TD\n A-->B\n%%' + 'y'.repeat(400000));
    await settle(page, 1200);
    const s = await ui(page);
    assert.match(s.toasts, /保存に失敗しました/);
    assert.equal(s.status, '未保存', '描画が成功しても未保存の警告が残る');
}));

test('D02 複数タブ: 他タブの変更・新規・削除が失われずに同期される', async () => {
    const page = await open(browser);
    const ctx = page.context();
    try {
        await ready(page);
        const page2 = await open(browser, { context: ctx });
        await ready(page2);
        await page.click('#newDocBtn');
        await setCode(page, 'graph TD\n TAB1-->X');
        await page.waitForTimeout(700);
        await setCode(page2, 'graph TD\n TAB2-->Y');
        await page2.waitForTimeout(700);
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mermaid_docs')).map(d => d.code));
        assert.ok(stored.some(c => c.includes('TAB1')), 'タブ1の新規ドキュメントが残る');
        assert.ok(stored.some(c => c.includes('TAB2')), 'タブ2の編集が残る');
        assert.equal(stored.length, 2, '初回起動の既定ドキュメントが重複しない');
        assert.equal((await ui(page2)).docs.length, 2, 'タブ2のドキュメント一覧にも反映');
        // タブ1で削除 → タブ2で復活しない
        await page.selectOption('#docSelect', { index: 1 });
        await page.click('#deleteDocBtn');
        await page2.waitForTimeout(300);
        await setCode(page2, 'graph TD\n TAB2-->Z');
        await page2.waitForTimeout(700);
        const after = await page.evaluate(() => JSON.parse(localStorage.getItem('mermaid_docs')).map(d => d.code));
        assert.equal(after.length, 1);
        assert.deepEqual([...page.errors, ...page2.errors], []);
    } finally { await ctx.close(); }
});

test('D03 削除は「元に戻す」で復元できる', () => withPage({}, async page => {
    await ready(page);
    await page.click('#newDocBtn');
    await setCode(page, 'graph TD\n KEEP-->ME');
    await page.click('#deleteDocBtn');
    assert.equal((await ui(page)).docs.length, 1);
    await page.click('.toast .act');
    await settle(page, 300);
    const s = await ui(page);
    assert.equal(s.docs.length, 2);
    assert.match(s.code, /KEEP/);
}));

/* ---------------- 共有・ファイル ---------------- */

test('S01 共有リンク: 圧縮形式で往復でき、同じ内容は重複作成しない', () => withPage({}, async page => {
    await ready(page);
    const src = 'journey\n title 共有テスト\n section S\n  t: 5: 私';
    await setCode(page, src);
    await page.click('#shareBtn');
    await page.waitForFunction(() => /共有リンクをコピー/.test(document.getElementById('toastHost').textContent));
    const url = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(url, /#z=[A-Za-z0-9_-]+$/);
    const page2 = await open(browser, { hash: url.slice(url.indexOf('#')) });
    try {
        await ready(page2);
        const s = await ui(page2);
        assert.equal(s.code, src);
        assert.equal(s.current, '共有図');
        // 同じタブでハッシュだけ変わった場合（アドレスバーに貼り直し）も取り込む／同一内容は再利用
        await page2.evaluate(h => { location.hash = h; }, url.slice(url.indexOf('#')));
        await settle(page2, 500);
        assert.equal((await ui(page2)).docs.filter(n => n.startsWith('共有図')).length, 1);
    } finally { await page2.context().close(); }
}));

test('S02 旧形式(#code=)・パーセントエンコード済みリンクも読める', () => withPage({
    hash: '#code=' + encodeURIComponent(Buffer.from('graph TD\n OLD-->LINK?+/').toString('base64'))
}, async page => {
    await ready(page);
    assert.match((await ui(page)).code, /OLD-->LINK/);
}));

test('S03 壊れた共有リンクは通知する（旧実装は無視）', () => withPage({ hash: '#z=' + zlib.deflateRawSync('graph TD').toString('base64url').slice(0, 3) }, async page => {
    await ready(page);
    assert.match((await ui(page)).toasts, /共有リンクを読み込めませんでした/);
}));

test('F01 バイナリ・巨大ファイルの読込を拒否し、Markdown からは mermaid ブロックを取り出す', () => withPage({}, async page => {
    await ready(page);
    await page.setInputFiles('#fileInput', { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0, 0, 1, 2]) });
    await page.waitForTimeout(300);
    assert.match((await ui(page)).toasts, /テキストファイルではない/);
    await page.setInputFiles('#fileInput', { name: 'big.mmd', mimeType: 'text/plain', buffer: Buffer.alloc(3 * 1024 * 1024, 0x61) });
    await page.waitForTimeout(300);
    assert.match((await ui(page)).toasts, /大きすぎます/);
    await page.setInputFiles('#fileInput', { name: 'readme.md', mimeType: 'text/markdown', buffer: Buffer.from('# 見出し\n\n```mermaid\ngraph LR\n MD-->OK\n```\n') });
    await settle(page, 500);
    const s = await ui(page);
    assert.equal(s.code, 'graph LR\n MD-->OK\n');
    assert.equal(s.current, 'readme');
    assert.equal(s.docs.length, 2);
}));

test('F02 書き出しファイル名にドキュメント名を使う', () => withPage({}, async page => {
    await ready(page);
    page.onDialog = d => d.accept('週次 / レポート');
    await page.click('#renameDocBtn');
    const svg = await download(page, '#svgBtn');
    assert.match(svg.name, /^週次 _ レポート-\d{8}-\d{4}\.svg$/);
}));

/* ---------------- レイアウト ---------------- */

test('L01 スマホ幅で横スクロールが発生しない', () => withPage({ viewport: { width: 375, height: 740 } }, async page => {
    await ready(page);
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
    assert.ok(o.sw <= o.w);
}));
