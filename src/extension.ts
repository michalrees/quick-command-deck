import * as vscode from 'vscode';
import { DEFAULT_COMMANDS, CommandItem } from './commands';

/** 面板视图 ID（与 package.json 里的 views 贡献保持一致） */
const VIEW_ID = 'quickCommandDeck.view';

/** 使用次数 / 排序偏好的存储键（存在 globalState，跨工作区保留） */
const STATE_USAGE = 'quickCommandDeck.usage';
const STATE_SORT = 'quickCommandDeck.sortMode';

type SortMode = 'default' | 'usage' | 'alpha';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new CommandDeckViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: false }
    })
  );

  // 命令面板入口：打开侧边栏并聚焦到本视图
  context.subscriptions.push(
    vscode.commands.registerCommand('quickCommandDeck.open', async () => {
      await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('quickCommandDeck.refresh', () => provider.refresh())
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('quickCommandDeck')) {
        provider.refresh();
      }
    })
  );
}

export function deactivate(): void {
  /* 无需清理 */
}

interface DeckItem extends CommandItem {
  available: boolean;
  /** true = 来自已安装扩展声明的键位（不是内置清单里的条目） */
  fromExtension?: boolean;
  /** 累计点击执行次数（本扩展自己统计） */
  usage?: number;
}

interface DeckSettings {
  fontSize: number;
  showKeys: boolean;
  dense: boolean;
  includeExtensions: boolean;
  userCommands: CommandItem[];
}

function readSettings(): DeckSettings {
  const cfg = vscode.workspace.getConfiguration('quickCommandDeck');
  const raw = cfg.get<CommandItem[]>('commands', []);
  return {
    fontSize: cfg.get<number>('fontSize', 14),
    showKeys: cfg.get<boolean>('showKeys', true),
    dense: cfg.get<boolean>('dense', false),
    includeExtensions: cfg.get<boolean>('includeExtensionCommands', true),
    userCommands: Array.isArray(raw) ? raw : []
  };
}

interface ExtensionContribution {
  key?: string;
  command?: string;
}

/** ctrl+shift+p → Ctrl+Shift+P */
function prettyKey(key: string): string {
  return key
    .split(' ')
    .map((chord) =>
      chord
        .split('+')
        .map((part) => {
          const p = part.trim();
          if (p.length === 1) {
            return p.toUpperCase();
          }
          if (/^f\d{1,2}$/i.test(p)) {
            return p.toUpperCase();
          }
          return p.charAt(0).toUpperCase() + p.slice(1);
        })
        .join('+')
    )
    .join(' ');
}

/** 命令 ID 形如 xxx.key.ctrl+right 的，是扩展用来转发按键的内部辅助命令 */
const KEY_PROXY_ID = /\.key\.(ctrl|shift|alt|cmd|meta|escape|enter|tab|space|left|right|up|down|home|end|pageup|pagedown|backspace|delete|f\d{1,2})([+.]|$)/i;

/** 把没有标题的命令 ID 变得可读一点。
 *  取最后两节（扩展名 + 命令名）以便辨认来源：
 *    gitlens.copyRemoteFileUrl → Gitlens Copy Remote File Url
 *    claude-vscode.terminal.open.keyboard → Open Keyboard
 */
function humanizeCommandId(id: string): string {
  const parts = String(id).split('.').filter(Boolean);
  const tail = parts.slice(-2).join(' ') || String(id);
  return tail
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** 收集已安装扩展贡献的命令标题与键位（走公开的 packageJSON） */
function collectExtensionContributions(): { titles: Map<string, string>; keys: Map<string, string> } {
  const titles = new Map<string, string>();
  const keys = new Map<string, string>();

  for (const ext of vscode.extensions.all) {
    const pkg = ext.packageJSON as
      | {
          contributes?: {
            commands?: Array<{ command?: string; title?: string }>;
            keybindings?: ExtensionContribution[];
          };
        }
      | undefined;
    const contributes = pkg?.contributes;
    if (!contributes) {
      continue;
    }

    // 只接受字符串：packageJSON 是任意 JSON，title/command 可能是数字或对象
    for (const c of contributes.commands ?? []) {
      if (typeof c?.command === 'string' && typeof c?.title === 'string' && !titles.has(c.command)) {
        titles.set(c.command, c.title);
      }
    }

    for (const kb of contributes.keybindings ?? []) {
      if (typeof kb?.command !== 'string' || typeof kb?.key !== 'string') {
        continue;
      }
      // 跳过内部按键代理命令：它们没有标题，列出来只是一串 "gitlens.key.ctrl+right" 噪音
      if (KEY_PROXY_ID.test(kb.command) && !titles.has(kb.command)) {
        continue;
      }
      if (!keys.has(kb.command)) {
        keys.set(kb.command, prettyKey(kb.key));
      }
    }
  }

  return { titles, keys };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

class CommandDeckViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(
      async (msg: { type?: string; command?: string; mode?: string }) => {
        if (msg?.type === 'sort' && msg.mode) {
          await this.setSortMode(msg.mode as SortMode);
          return;
        }
        const cmd = msg?.command;
        if ((msg?.type === 'execute' || msg?.type === 'run') && cmd) {
          await this.bumpUsage(cmd);
          try {
            await vscode.commands.executeCommand(cmd);
          } catch (err) {
            vscode.window.showWarningMessage(
              `命令执行失败：${cmd} —— ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    );

    void this.render();
  }

  public refresh(): void {
    void this.render();
  }

  private usageMap(): Record<string, number> {
    return this.context.globalState.get<Record<string, number>>(STATE_USAGE, {});
  }

  private sortMode(): SortMode {
    const m = this.context.globalState.get<string>(STATE_SORT, 'default');
    return m === 'usage' || m === 'alpha' ? (m as SortMode) : 'default';
  }

  private async setSortMode(mode: SortMode): Promise<void> {
    await this.context.globalState.update(STATE_SORT, mode);
    await this.render();
  }

  /** 记一次点击；存 globalState，跨工作区累计 */
  private async bumpUsage(command: string): Promise<void> {
    const map = { ...this.usageMap() };
    map[command] = (map[command] ?? 0) + 1;
    await this.context.globalState.update(STATE_USAGE, map);
  }

  private async render(): Promise<void> {
    if (!this.view) {
      return;
    }
    const { fontSize, showKeys, dense, includeExtensions, userCommands } = readSettings();

    let available: Set<string>;
    try {
      available = new Set(await vscode.commands.getCommands(true));
    } catch {
      available = new Set<string>();
    }

    const { titles, keys } = collectExtensionContributions();
    const usage = this.usageMap();

    // 设置里的 commands 是任意 JSON，label/command 可能是 undefined 或非字符串，
    // 一律 String() 兜住，避免后续比较/排序抛异常
    const base: CommandItem[] = userCommands.length > 0 ? userCommands : DEFAULT_COMMANDS;
    const curated: DeckItem[] = base
      .filter((it) => it && it.command)
      .map((it) => ({
        label: String(it.label ?? it.command),
        command: String(it.command),
        keys: it.keys ? String(it.keys) : keys.get(String(it.command)),
        available: available.has(String(it.command))
      }));

    const extras: DeckItem[] = [];
    if (includeExtensions) {
      for (const [command, key] of keys) {
        if (!available.has(command)) {
          continue;
        }
        extras.push({
          // 有正式标题就用标题；没有则把命令 ID 尾部转成可读文本
          label: titles.get(command) ?? humanizeCommandId(command),
          command: String(command),
          keys: key ? String(key) : undefined,
          available: true,
          fromExtension: true
        });
      }
      extras.sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'));
    }

    // ── 双向去重 ────────────────────────────────────────────────────────
    // ① 命令 ID 相同：内置清单与扩展声明常指向同一命令 → 保留先出现的（内置优先）
    // ② 键位相同：不同扩展声明同一键位 → 只保留第一个
    const seenCommands = new Set<string>();
    const seenKeys = new Set<string>();
    const merged: DeckItem[] = [];
    for (const it of [...curated, ...extras]) {
      const cmd = String(it.command);
      if (seenCommands.has(cmd)) {
        continue;
      }
      const kb = it.keys ? String(it.keys) : '';
      if (kb) {
        const norm = kb.toLowerCase().replace(/\s+/g, ' ').trim();
        if (seenKeys.has(norm)) {
          continue;
        }
        seenKeys.add(norm);
      }
      seenCommands.add(cmd);
      merged.push(it);
    }

    // 附上使用次数
    for (const it of merged) {
      it.usage = usage[it.command] ?? 0;
    }

    const mode = this.sortMode();
    if (mode === 'usage') {
      // 用过的排前面（次数多的在前）；没用过的是 0，保持原顺序垫后
      merged.sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0));
    } else if (mode === 'alpha') {
      merged.sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'));
    }

    try {
      this.view.webview.html = buildHtml(merged, {
        fontSize,
        showKeys,
        dense,
        mode,
        nonce: nonce()
      });
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.view.webview.html =
        `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:10px;color:var(--vscode-foreground)">` +
        `<b>Command Deck 渲染失败</b><pre style="white-space:pre-wrap">${escapeHtml(detail)}</pre></body></html>`;
      console.error('[quick-command-deck] render failed:', err);
    }
  }
}

function buildHtml(
  items: DeckItem[],
  opts: { fontSize: number; showKeys: boolean; dense: boolean; mode: SortMode; nonce: string }
): string {
  const payload = JSON.stringify({
    items: items.map((i) => ({
      n: String(i.label ?? ''),
      c: String(i.command ?? ''),
      k: i.keys === undefined || i.keys === null ? '' : String(i.keys),
      a: !!i.available,
      e: i.fromExtension ? 1 : 0,
      u: i.usage ?? 0
    })),
    showKeys: !!opts.showKeys,
    sortMode: opts.mode
  });

  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${opts.nonce}'`,
    `script-src 'nonce-${opts.nonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style nonce="${opts.nonce}">
  :root {
    --deck-font: ${opts.fontSize}px;
    --deck-rowgap: ${opts.dense ? 1 : 2}px;
    --deck-pady: ${opts.dense ? 3 : 5}px;
    --deck-padx: ${opts.dense ? 8 : 10}px;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex;
    flex-direction: column;
    font-size: var(--deck-font);
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    overflow: hidden;
  }
  .toolbar {
    flex: 0 0 auto;
    padding: 6px 6px 4px 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    background: var(--vscode-sideBar-background, transparent);
  }
  #q {
    width: 100%;
    padding: 5px 8px;
    font: inherit;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    outline: none;
  }
  #q:focus { border-color: var(--vscode-focusBorder); }
  #q::placeholder { color: var(--vscode-input-placeholderForeground); }

  .sortrow { display: flex; align-items: center; gap: 6px; }
  .sortbtn {
    font: inherit;
    font-size: .85em;
    padding: 2px 7px;
    color: var(--vscode-foreground);
    background: transparent;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
    border-radius: 4px;
    cursor: pointer;
    opacity: .85;
  }
  .sortbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); opacity: 1; }
  .sorthint { font-size: .8em; opacity: .55; }

  .list {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 2px 6px 8px 6px;
    display: flex;
    flex-direction: column;
    gap: var(--deck-rowgap);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: var(--deck-pady) var(--deck-padx);
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    font: inherit;
    text-align: left;
    cursor: pointer;
    width: 100%;
  }
  .row:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.18)); }
  .row.sel {
    background: var(--vscode-list-activeSelectionBackground, rgba(128,128,128,.3));
    color: var(--vscode-list-activeSelectionForeground, inherit);
    border-color: var(--vscode-focusBorder, transparent);
  }
  .row .label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.missing { opacity: .45; cursor: not-allowed; }

  .keys { flex: 0 0 auto; display: flex; align-items: center; gap: 3px; white-space: nowrap; }
  .key {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.35em;
    padding: 1px 5px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: .82em;
    line-height: 1.5;
    color: var(--vscode-keybindingLabel-foreground, var(--vscode-foreground));
    background: var(--vscode-keybindingLabel-background, rgba(128,128,128,.14));
    border: 1px solid var(--vscode-keybindingLabel-border, rgba(128,128,128,.45));
    border-bottom-color: var(--vscode-keybindingLabel-bottomBorder, rgba(128,128,128,.7));
    border-radius: 4px;
  }
  .plus { font-size: .8em; opacity: .55; }
  .sep {
    margin: 9px 4px 1px 4px;
    padding-top: 6px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    font-size: .82em;
    opacity: .6;
  }
  .empty { padding: 10px; opacity: .6; font-size: .9em; }
</style>
</head>
<body>
  <div class="toolbar">
    <input id="q" type="text" placeholder="搜索命令或键位…" autocomplete="off" spellcheck="false" />
    <div class="sortrow">
      <button class="sortbtn" id="sortbtn" type="button"></button>
      <span class="sorthint" id="sorthint"></span>
    </div>
  </div>
  <div class="list" id="list"></div>

<script nonce="${opts.nonce}">
  const vscode = acquireVsCodeApi();
  const DATA = ${payload};
  const SHOW_KEYS = ${opts.showKeys ? 'true' : 'false'};

  const MODES = ['default', 'usage', 'alpha'];
  const MODE_LABEL = { default: '默认顺序', usage: '按使用次数', alpha: '按名称' };
  let mode = DATA.sortMode || 'default';

  const q = document.getElementById('q');
  const list = document.getElementById('list');
  const sortBtn = document.getElementById('sortbtn');
  const sortHint = document.getElementById('sorthint');
  let rows = [];
  let sel = 0;

  function updateSortUi() {
    sortBtn.textContent = '排序：' + MODE_LABEL[mode];
    sortBtn.title = '点击切换排序方式：默认顺序 → 按使用次数 → 按名称';
    const used = DATA.items.filter(function (i) { return (i.u || 0) > 0; }).length;
    sortHint.textContent = mode === 'usage' ? ('已记录 ' + used + ' 条') : '';
  }

  function buildKeys(text) {
    const wrap = document.createElement('span');
    wrap.className = 'keys';
    const chords = String(text).split(' ');
    chords.forEach(function (chord, ci) {
      if (ci > 0) {
        const sp = document.createElement('span');
        sp.className = 'plus';
        sp.textContent = ' ';
        wrap.appendChild(sp);
      }
      chord.split('+').forEach(function (p, pi) {
        if (pi > 0) {
          const plus = document.createElement('span');
          plus.className = 'plus';
          plus.textContent = '+';
          wrap.appendChild(plus);
        }
        const k = document.createElement('span');
        k.className = 'key';
        k.textContent = p;
        wrap.appendChild(k);
      });
    });
    return wrap;
  }

  function makeRow(it) {
    const btn = document.createElement('button');
    btn.className = 'row' + (it.a ? '' : ' missing');
    btn.disabled = !it.a;
    btn.dataset.command = it.c;
    btn.title = it.c + (it.a ? '' : '（当前不可用）') + (it.u ? '   已使用 ' + it.u + ' 次' : '');

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = it.n;
    btn.appendChild(label);

    if (SHOW_KEYS && it.k) {
      btn.appendChild(buildKeys(it.k));
    }

    btn.addEventListener('click', function () { fire(it); });
    return btn;
  }

  function render(items) {
    list.textContent = '';
    rows = [];
    let sepShown = false;
    items.forEach(function (it) {
      if (it.e && !sepShown) {
        const sep = document.createElement('div');
        sep.className = 'sep';
        sep.textContent = '来自已安装扩展';
        list.appendChild(sep);
        sepShown = true;
      }
      const btn = makeRow(it);
      list.appendChild(btn);
      rows.push({ el: btn, item: it });
    });
    if (rows.length === 0) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = '没有匹配的命令';
      list.appendChild(d);
    }
    select(0);
  }

  function fire(it) {
    if (!it || !it.a) return;
    vscode.postMessage({ type: 'execute', command: it.c });
  }

  function select(i) {
    if (rows.length === 0) return;
    sel = Math.max(0, Math.min(i, rows.length - 1));
    rows.forEach(function (r, idx) { r.el.classList.toggle('sel', idx === sel); });
    const cur = rows[sel];
    if (cur) cur.el.scrollIntoView({ block: 'nearest' });
  }

  function filter() {
    const term = q.value.trim().toLowerCase();
    if (!term) {
      render(DATA.items);
      return;
    }
    render(DATA.items.filter(function (it) {
      return (it.n + ' ' + it.c + ' ' + (it.k || '')).toLowerCase().indexOf(term) >= 0;
    }));
  }

  q.addEventListener('input', filter);

  q.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(sel - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const cur = rows[sel];
      if (cur) fire(cur.item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (q.value) { q.value = ''; filter(); }
    }
  });

  // 点一下在三种排序间循环；真正生效要扩展侧重新排序并重绘
  sortBtn.addEventListener('click', function () {
    mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    updateSortUi();
    vscode.postMessage({ type: 'sort', mode: mode });
  });

  updateSortUi();
  render(DATA.items);
  q.focus();
</script>
</body>
</html>`;
}
