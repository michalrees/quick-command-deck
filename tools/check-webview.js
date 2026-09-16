#!/usr/bin/env node
/*
 * Webview 内联脚本自检 —— 专治「tsc 编译通过，窗口里白屏」。
 *
 * 背景
 * ----
 * buildHtml() 返回的是一个模板字符串，内联进 webview 的 <script> 属于
 * 「字符串里的字符串」。在那一整块里写反斜杠转义会被**外层**模板字符串
 * 先消费一遍：
 *   · 用「反斜杠 + n」表示换行  -> 变成真正的换行，单引号字符串跨行 -> SyntaxError
 *   · 用「反斜杠 + s」写正则    -> 反斜杠消失，正则语法非法     -> SyntaxError
 * 两种都让整段脚本报废、面板全白，而 tsc 一声不吭。
 *
 * 检查项（针对 out/extension.js，也就是 VS Code 真正 require 的那个文件）
 * ----------------------------------------------------------------------
 *   1. webview 模板区间内不得出现任何反斜杠；
 *   2. 用 buildHtml() 真造一份 HTML（含恶意标题），校验内联脚本的语法；
 *   3. payload 里的字符串必须逐字节还原（转义只准改写法，不准改数据）。
 *
 * 用法
 * ----
 *   node tools/check-webview.js                    # 检查 out/extension.js
 *   node tools/check-webview.js <path/to/out.js>   # 检查指定产物（自测用）
 *   npm run check                                  # 先 compile 再自检（推荐）
 *
 * 退出码 0 = 通过；1 = 有问题（别重载窗口，先修）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, '..', 'out', 'extension.js');
const problems = [];
const passes = [];

const ok = (msg) => passes.push(msg);
const bad = (msg) => problems.push(msg);

if (!fs.existsSync(target)) {
  console.error('✗ 找不到编译产物：' + target);
  console.error('  先跑 npm run compile（或直接用 npm run check）。');
  process.exit(1);
}

const src = fs.readFileSync(target, 'utf8');

// ────────────────────────────────────────────────────────────────
// 1. webview 模板区间内不允许出现反斜杠
// ────────────────────────────────────────────────────────────────
// 模板起点必须从 buildHtml() 里往后找：render() 的兜底 HTML 也是一个
// <!DOCTYPE html> 模板字符串，直接 indexOf('<!DOCTYPE html>') 会定位到那儿，
// 把 buildHtml 里正常的普通代码（例如 payload 的 replace）误判成模板内容。
const fnIdx = src.indexOf('function buildHtml(');
let templateStart = -1;
if (fnIdx < 0) {
  bad('产物里找不到 buildHtml()');
} else {
  templateStart = src.indexOf('`', fnIdx);
  if (templateStart < 0) {
    bad('buildHtml() 里找不到模板字符串的起始反引号');
    templateStart = -1;
  } else if (src.indexOf('<!DOCTYPE html>', templateStart) < 0) {
    bad('buildHtml() 的模板里找不到 <!DOCTYPE html>，模板可能被改写了');
    templateStart = -1;
  }
}

if (templateStart >= 0) {
  const baseLine = src.slice(0, templateStart).split('\n').length; // 模板第一行在产物里的行号
  const hits = [];
  src
    .slice(templateStart)
    .split('\n')
    .forEach((line, i) => {
      if (line.indexOf('\\') >= 0) {
        hits.push('第 ' + (baseLine + i) + ' 行: ' + line.trim().slice(0, 100));
      }
    });
  if (hits.length) {
    bad(
      'webview 模板内出现反斜杠 —— 会被外层模板字符串先吃掉一遍：\n      ' +
        hits.join('\n      ') +
        '\n      改法：控制字符用 String.fromCharCode(n)，或把常量放到模板外再 ${插值}。'
    );
  } else {
    ok('模板区间内无反斜杠');
  }
}

// ────────────────────────────────────────────────────────────────
// 2. 真造一份 HTML，校验内联脚本语法
// ────────────────────────────────────────────────────────────────
const HOSTILE = 'evil </script><b>x</b> <!-- y -->';
let inlineScript = null;

if (fnIdx >= 0) {
  let buildHtml = null;
  try {
    const body = src.slice(fnIdx).replace(/\/\/#\s*sourceMappingURL=.*$/m, '');
    buildHtml = new Function('return ' + body)();
  } catch (e) {
    bad('无法取出 buildHtml()：' + e.message);
  }

  if (buildHtml) {
    const items = [
      { label: '快速打开文件', command: 'workbench.action.quickOpen', keys: 'Ctrl+P', available: true, source: '', usage: 3 },
      { label: '命令面板', command: 'workbench.action.showCommands', keys: 'Ctrl+Shift+P', available: false, source: '内置', usage: 0 },
      { label: HOSTILE, command: 'evil.cmd', keys: '', available: true, source: 'test', usage: 0 }
    ];
    const opts = { fontSize: 14, showKeys: true, dense: false, mode: 'default', nonce: 'CHECKNONCE' };

    let html = '';
    try {
      html = buildHtml(items, opts);
    } catch (e) {
      bad('buildHtml() 抛异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
    }

    if (html) {
      const m = html.match(/<script nonce="CHECKNONCE">([\s\S]*?)<\/script>/);
      if (!m) {
        bad('生成的 HTML 里没找到内联 <script>（nonce 对不上或被提前闭合）');
      } else {
        inlineScript = m[1];
        try {
          new Function(inlineScript); // 只编译，不执行
          ok('内联脚本语法 OK（' + inlineScript.split('\n').length + ' 行）');
        } catch (e) {
          bad('内联脚本语法错误：' + e.message);
        }

        // ── 3. payload 必须逐字节还原 ──
        const dm = inlineScript.match(/const DATA = (\{[\s\S]*?\});/);
        if (!dm) {
          bad('内联脚本里找不到 const DATA = {...}');
        } else {
          try {
            const data = JSON.parse(dm[1]);
            const labels = data.items.map((i) => i.n);
            if (labels.indexOf(HOSTILE) >= 0) {
              ok('payload 含 < 的标题逐字节还原（' + JSON.stringify(HOSTILE) + '）');
            } else {
              bad('payload 字符串被转义改坏了，期望原样出现：' + JSON.stringify(HOSTILE));
            }
          } catch (e) {
            bad('const DATA 不是合法 JSON：' + e.message);
          }
        }
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────
// 汇总
// ────────────────────────────────────────────────────────────────
console.log('检查文件：' + target);
passes.forEach((p) => console.log('  ✓ ' + p));
problems.forEach((p) => console.log('  ✗ ' + p));
if (problems.length) {
  console.log('\n结果：不通过（' + problems.length + " 处问题）—— 现在别重载窗口，先修上面的问题。");
  process.exit(1);
}
console.log('\n结果：通过 —— 可以放心重载窗口（Ctrl+R）了。');
