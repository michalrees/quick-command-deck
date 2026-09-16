import * as vscode from 'vscode';
import { DEFAULT_COMMANDS, CommandItem, collectExtensionKeybindings, prettyKey } from './commands';

/** 面板视图 ID（与 package.json 里的 views 贡献保持一致） */
const VIEW_ID = 'quickCommandDeck.view';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new CommandDeckViewProvider();

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
    fontSize: cfg.get<number>('fontSize', 16),
    showKeys: cfg.get<boolean>('showKeys', true),
    dense: cfg.get<boolean>('dense', false),
    includeExtensions: cfg.get<boolean>('includeExtensionCommands', true),
    userCommands: Array.isArray(raw) ? raw : []
  };
}

interface ExtensionContribution {
  key?: string;
  command?: string;
  title?: string;
}

/**
 * 收集已安装扩展贡献的：命令标题 + 键位。
 * 走的是扩展公开的 packageJSON（稳定可用），不依赖任何私有实现。
 */
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

    // 只接受字符串：扩展的 packageJSON 是任意 JSON，title/command 可能是数字或对象，
    // 直接塞进 Map 会让后面 String 之外的操作（如 localeCompare）出错。
    for (const c of contributes.commands ?? []) {
      if (typeof c?.command === 'string' && typeof c?.title === 'string' && !titles.has(c.command)) {
        titles.set(c.command, c.title);
      }
    }

    for (const kb of contributes.keybindings ?? []) {
      if (typeof kb?.command === 'string' && typeof kb?.key === 'string' && !keys.has(kb.command)) {
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

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage(async (msg: { type?: string; command?: string }) => {
      const cmd = msg?.command;
      if ((msg?.type === 'execute' || msg?.type === 'run') && cmd) {
        try {
          await vscode.commands.executeCommand(cmd);
        } catch (err) {
          vscode.window.showWarningMessage(
            `命令执行失败：${cmd} —— ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    });

    void this.render();
  }

  public refresh(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    if (!this.view) {
      return;
    }
    const { fontSize, showKeys, dense, includeExtensions, userCommands } = readSettings();

    // 可用命令：不存在的置灰，避免"点了没反应"
    let available: Set<string>;
    try {
      available = new Set(await vscode.commands.getCommands(true));
    } catch {
      available = new Set<string>();
    }

    const { titles, keys } = collectExtensionContributions();

    // 注意：用户设置里的 commands 是任意 JSON，label/command 有可能是 undefined 或非字符串，
    //       这里一律用 String() 兜住，否则后面 sort 时 .localeCompare 会抛
    //       "a.label.localeCompare is not a function"，导致整个 render 失败、视图空白。
    const base: CommandItem[] = userCommands.length > 0 ? userCommands : DEFAULT_COMMANDS;
    const items: DeckItem[] = base
      .filter((it) => it && it.command)
      .map((it) => ({
        label: String(it.label ?? it.command),
        command: String(it.command),
        keys: it.keys ? String(it.keys) : keys.get(String(it.command)),
        available: available.has(String(it.command))
      }));

    // 扩展声明的键位并入主列表（与内置清单去重，仅保留当前可用、且不在清单里的）
    const known = new Set(items.map((i) => i.command));
    const extras: DeckItem[] = [];
    if (includeExtensions) {
      for (const [command, key] of keys) {
        if (known.has(command) || !available.has(command)) {
          continue;
        }
        extras.push({
          label: String(titles.get(command) ?? command),
          command: String(command),
          keys: key ? String(key) : undefined,
          available: true,
          fromExtension: true
        });
      }
      extras.sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'));
    }

    // 兜底：任何渲染异常都直接显示在视图里，而不是留下一片空白让人猜
    try {
      this.view.webview.html = buildHtml(items, extras, {
        fontSize,
        showKeys,
        dense,
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
  extras: DeckItem[],
  opts: { fontSize: number; showKeys: boolean; dense: boolean; nonce: string }
): string {
  const all = items.concat(extras);
  // 全部强制转字符串：payload 直接进脚本，任何非字符串都可能让前端崩
  const payload = JSON.stringify({
    items: all.map((i) => ({
      n: String(i.label ?? ''),
      c: String(i.command ?? ''),
      k: i.keys === undefined || i.keys === null ? '' : String(i.keys),
      a: !!i.available,
      e: i.fromExtension ? 1 : 0
    })),
    showKeys: !!opts.showKeys,
    extStart: extras.length > 0 ? items.length : -1
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
  .searchwrap {
    flex: 0 0 auto;
    padding: 6px 6px 4px 6px;
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
    gap: 10px;
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
  .row .dict { flex: 0 0 auto; font-size: .82em; opacity: .7; white-space: nowrap; }
  .row.missing { opacity: .45; cursor: not-allowed; }
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
  <div class="searchwrap">
    <input id="q" type="text" placeholder="搜索命令或键位…" autocomplete="off" spellcheck="false" />
  </div>
  <div class="list" id="list"></div>

<script nonce="${opts.nonce}">
  const vscode = acquireVsCodeApi();
  const DATA = ${payload};
  const SHOW_KEYS = ${opts.showKeys ? 'true' : 'false'};

  const q = document.getElementById('q');
  const list = document.getElementById('list');
  let rows = [];
  let sel = 0;

  function makeRow(it) {
    const btn = document.createElement('button');
    btn.className = 'row' + (it.a ? '' : ' missing');
    btn.disabled = !it.a;
    btn.dataset.command = it.c;
    btn.title = it.c + (it.a ? '' : '（当前不可用）');

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = it.n;
    btn.appendChild(label);

    if (SHOW_KEYS && it.k) {
      const k = document.createElement('span');
      k.className = 'dict';
      k.textContent = it.k;
      btn.appendChild(k);
    }

    btn.addEventListener('click', function () { fire(it); });
    return btn;
  }

  function render(items, sepAt) {
    list.textContent = '';
    rows = [];
    items.forEach(function (it, idx) {
      if (sepAt >= 0 && idx === sepAt) {
        const sep = document.createElement('div');
        sep.className = 'sep';
        sep.textContent = '来自已安装扩展';
        list.appendChild(sep);
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
      render(DATA.items, DATA.extStart);
      return;
    }
    const hit = DATA.items.filter(function (it) {
      return (it.n + ' ' + it.c + ' ' + (it.k || '')).toLowerCase().indexOf(term) >= 0;
    });
    render(hit, -1);
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

  render(DATA.items, DATA.extStart);
  q.focus();
</script>
</body>
</html>`;
}
