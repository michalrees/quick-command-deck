#!/usr/bin/env node
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-check-'));
const keyFile = path.join(root, 'keybindings.json');
const code = fs.readFileSync(path.join(__dirname, '../out/extension.js'), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass = label => console.log('  ✓ ' + label);

function environment(platform = process.platform) {
  const settings = { keybindingsPath: keyFile, includeExtensionCommands: true };
  const state = new Map();
  const warnings = [], documents = [], executions = [], watchers = new Map();
  let reads = 0, failUsage = false, commandQuery;
  const disk = { ...fs, readFileSync(...args) { reads++; return fs.readFileSync(...args); },
    watchFile(file, _opts, fn) { watchers.set(file, fn); },
    unwatchFile(file) { watchers.delete(file); } };
  const vscode = {
    workspace: { getConfiguration: () => ({ get: (k, fallback) => settings[k] ?? fallback }),
      openTextDocument: async options => { documents.push(options.content); return options; } },
    extensions: { all: [{ id: 'test.demo', extensionPath: root, packageJSON: { name: 'demo', contributes: {
      commands: [{ command: 'demo.a', title: 'A' }, { command: 'demo.b', title: 'B' }],
      keybindings: [{ command: 'demo.a', key: 'ctrl+x', mac: 'cmd+x', linux: 'alt+x' },
        { command: 'demo.b', key: 'ctrl+x', mac: 'cmd+x', linux: 'alt+x' }]
    } } }] },
    window: { showWarningMessage: message => warnings.push(message), showTextDocument: async () => {} },
    commands: { getCommands: async () => commandQuery ? commandQuery() : ['workbench.action.quickOpen', 'demo.a', 'demo.b'],
      executeCommand: async command => executions.push(command) }
  };
  const context = { globalStorageUri: { fsPath: path.join(root, 'User/globalStorage/test.deck') }, globalState: {
    get: (key, fallback) => state.get(key) ?? fallback,
    update: async (key, value) => { await sleep(5); if (failUsage && key.endsWith('.usage')) throw Error('storage unavailable'); state.set(key, value); }
  } };
  const sandbox = { exports: {}, require: id => id === 'vscode' ? vscode : id === 'fs' ? disk : require(id.startsWith('.') ? path.join(__dirname, '../out', id) : id),
    process: { platform, env: {} }, console: { log() {}, warn() {}, error: console.error }, setTimeout, clearTimeout };
  vm.runInNewContext(code + '\nexports.TestProvider = CommandDeckViewProvider; exports.readBindings = readUserKeybindings;', sandbox);
  const provider = new sandbox.exports.TestProvider(context);
  const sent = [];
  let html = '', htmlWrites = 0, handler;
  const view = { webview: { options: {}, get html() { return html; }, set html(value) { html = value; htmlWrites++; },
    postMessage: async data => { sent.push(data); return true; },
    onDidReceiveMessage: fn => { handler = fn; return { dispose() {} }; } }, onDidDispose: () => ({ dispose() {} }) };
  return { settings, state, warnings, documents, executions, watchers, provider, view, extensions: vscode.extensions,
    readBindings: sandbox.exports.readBindings, send: msg => handler(msg), sent,
    reads: () => reads, htmlWrites: () => htmlWrites,
    failUsage: value => { failUsage = value; }, query: value => { commandQuery = value; } };
}

(async () => {
  console.log('行为回归检查（临时文件和模拟 VS Code）');
  fs.writeFileSync(keyFile, '// comment\n[{"command":"demo,]","key":"ctrl+x",},]');
  const env = environment();
  assert(env.readBindings(keyFile).map.has('demo,]'));
  pass('JSONC 注释与尾逗号正常，字符串内容不变');
  fs.writeFileSync(keyFile, '[{"command":"x",]');
  assert(env.readBindings(keyFile).error);
  pass('非法 JSONC 明确报告解析错误');
  fs.writeFileSync(keyFile, JSON.stringify([
    { command: 'workbench.action.quickOpen', key: 'ctrl+u' },
    { command: 'demo.a', key: 'ctrl+1', when: 'editorTextFocus' },
    { command: 'demo.a', key: 'ctrl+2', when: 'terminalFocus' },
    { command: '-demo.b', key: 'alt+x' }
  ]));
  env.provider.resolveWebviewView(env.view);
  await sleep(20);
  await env.send({ type: 'ready' });
  let data = env.sent.at(-1);
  assert.equal(data.items.find(i => i.c === 'workbench.action.quickOpen').k, 'Ctrl+U');
  assert(data.items.find(i => i.c === 'demo.a').k.includes('terminalFocus'));
  assert.equal(data.items.find(i => i.c === 'demo.b').k, '');
  pass('用户键位覆盖默认；多个条件绑定保留；解绑不显示旧默认');
  fs.writeFileSync(keyFile, '[]');
  env.watchers.get(keyFile)();
  await sleep(130);
  data = env.sent.at(-1);
  assert(data.items.some(i => i.c === 'demo.a') && data.items.some(i => i.c === 'demo.b'));
  assert.equal(data.items.find(i => i.c === 'demo.a').k, data.items.find(i => i.c === 'demo.b').k);
  pass('同键位的不同命令全部保留；文件变化触发更新');
  const readsBefore = env.reads();
  const messagesBefore = env.sent.length;
  env.provider.refresh(); env.provider.refresh(); env.provider.refresh();
  await sleep(130);
  assert.equal(env.sent.length, messagesBefore + 1);
  assert.equal(env.reads(), readsBefore);
  assert.equal(env.htmlWrites(), 1);
  pass('连续刷新合并、复用缓存并仅更新数据，不重建 HTML');
  let release;
  env.query(() => new Promise(r => { release = r; }));
  const stale = env.provider.render();
  await sleep(1);
  env.query(() => ['demo.a']);
  await env.provider.render();
  const newest = env.sent.length;
  release([]); await stale;
  assert.equal(env.sent.length, newest);
  pass('过期异步刷新不会覆盖新结果');
  env.query(undefined);
  await env.provider.render();
  env.failUsage(true);
  await env.send({ type: 'execute', command: 'demo.a' });
  await sleep(20);
  assert(env.executions.includes('demo.a'));
  env.failUsage(false);
  await Promise.all(Array.from({ length: 8 }, () => env.send({ type: 'execute', command: 'demo.a' })));
  await env.provider.usagePending;
  assert.equal(env.state.get('quickCommandDeck.usage')['demo.a'], 8);
  pass('统计保存失败不阻断执行；并发点击不丢次数');
  const executed = env.executions.length;
  await env.send({ type: 'execute', command: 'unlisted.command' });
  assert.equal(env.executions.length, executed);
  pass('消息只能执行面板允许的命令');
  await env.provider.diagnose();
  assert(env.documents.at(-1).includes(keyFile));
  assert(env.documents.at(-1).includes('条件绑定'));
  pass('诊断报告包含文件来源、解析和命令状态');
  env.settings.commands = [{ label: 'Custom', command: 'demo.a', keys: 'Explicit' }];
  await env.provider.render();
  assert.equal(env.sent.at(-1).items.find(i => i.c === 'demo.a').k, 'Explicit');
  pass('用户清单明确指定的提示值仍优先');
  env.extensions.all[0].packageJSON.contributes.commands.push({ command: 'demo.lazy', title: 'Lazy' });
  env.extensions.all[0].packageJSON.contributes.keybindings.push({ command: 'demo.lazy', key: 'ctrl+l' });
  env.provider.invalidate();
  await sleep(130);
  assert(env.sent.at(-1).items.find(i => i.c === 'demo.lazy').a);
  await env.send({ type: 'execute', command: 'demo.lazy' });
  assert(env.executions.includes('demo.lazy'));
  pass('扩展变化使缓存失效，尚未注册的扩展命令可点击以触发懒激活');

  const mac = environment('darwin');
  mac.provider.resolveWebviewView(mac.view); await sleep(20); await mac.send({ type: 'ready' });
  assert.equal(mac.sent.at(-1).items.find(i => i.c === 'demo.a').k, 'Cmd+X');
  pass('扩展键位采用当前平台覆盖值');

  // 执行生成的真实内联脚本，验证状态恢复与消息刷新。
  class Element {
    constructor() { this.children = []; this.style = { setProperty() {} }; this.dataset = {}; this.listeners = {}; this.classList = { toggle() {} }; this.value = ''; this.scrollTop = 0; }
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text || ''; }
    appendChild(child) { this.children.push(child); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    scrollIntoView() {} focus() {}
  }
  const elements = Object.fromEntries(['q', 'list', 'sortsel', 'seg', 'hint', 'clear'].map(id => [id, new Element()]));
  const browser = { console, document: { getElementById: id => elements[id], createElement: () => new Element(), body: new Element(), documentElement: new Element() },
    window: { addEventListener: (_name, fn) => { browser.receive = fn; } },
    acquireVsCodeApi: () => ({ getState: () => ({ query: 'demo', scroll: 42, selected: 'demo.b' }), setState: value => { browser.saved = value; }, postMessage() {} }) };
  const inline = env.view.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(inline, browser);
  assert.equal(elements.q.value, 'demo');
  assert.equal(elements.list.scrollTop, 42);
  assert.equal(browser.saved.selected, 'demo.b');
  browser.receive({ data: mac.sent.at(-1) });
  assert.equal(elements.q.value, 'demo');
  assert.equal(elements.list.scrollTop, 42);
  assert.equal(browser.saved.selected, 'demo.b');
  pass('真实前端脚本恢复并保留搜索词、滚动位置和选中命令');
  env.provider.dispose(); mac.provider.dispose();
  assert.equal(env.watchers.size, 0);
  pass('销毁时清理文件监听与定时器');
  console.log('全部通过');
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
