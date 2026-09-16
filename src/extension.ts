import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_COMMANDS, CommandItem } from './commands';

/** 面板视图 ID（与 package.json 里的 views 贡献保持一致） */
const VIEW_ID = 'quickCommandDeck.view';

/** 使用次数 / 排序偏好的存储键（存在 globalState，跨工作区保留） */
const STATE_USAGE = 'quickCommandDeck.usage';
const STATE_SORT = 'quickCommandDeck.sortMode';

type SortMode = 'default' | 'usage' | 'alpha' | 'source';

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
  /** 来源：undefined/'' = 内置清单；否则为扩展显示名 */
  source?: string;
  /** 组内排序用：命令标题（不含前缀） */
  bare?: string;
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

/** 命令 ID 形如 xxx.key.ctrl+right 的，是扩展用来转发按键的内部辅助命令 */
const KEY_PROXY_ID =
  /\.key\.(ctrl|shift|alt|cmd|meta|escape|enter|tab|space|left|right|up|down|home|end|pageup|pagedown|backspace|delete|f\d{1,2})([+.]|$)/i;

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

/** 把没有标题的命令 ID 变得可读：去掉该扩展的命名空间，剩下的按驼峰/连字符拆词 */
function humanizeCommandId(id: string, strip?: string): string {
  let s = String(id);
  if (strip) {
    const ns = strip.endsWith('.') ? strip : strip + '.';
    if (s.toLowerCase().startsWith(ns.toLowerCase())) {
      s = s.slice(ns.length);
    }
  }
  return (
    s
      .split('.')
      .filter(Boolean)
      .join(' ')
      .replace(/[-_]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (ch) => ch.toUpperCase()) || String(id)
  );
}

/** 粗略判断某命令是否属于该扩展的命名空间（用于给内置命令标来源） */
function belongsToNamespace(command: string, extId: string): boolean {
  const ns = extId.toLowerCase();
  const cmd = command.toLowerCase();
  return cmd === ns || cmd.startsWith(ns + '.') || cmd.startsWith(ns + '-');
}

interface Contributions {
  /** 命令 ID → 扩展显示名 */
  owners: Map<string, string>;
  /** 命令 ID → 该扩展命名空间（用于生成裸标题） */
  namespaces: Map<string, string>;
  /** 命令 ID → 标题（去掉"扩展名: "前缀后的裸标题） */
  bareTitles: Map<string, string>;
  /** 命令 ID → 扩展声明的默认键位 */
  keys: Map<string, string>;
  /** 扩展 ID（小写）→ 显示名，用于按命名空间反查来源 */
  extNames: Map<string, string>;
  /** 命令 ID → 用户自己在 keybindings.json 里绑的键位 */
  userKeys: Map<string, string>;
}

/**
 * 定位用户的 keybindings.json。
 *
 * 顺序：
 *   1. 由本扩展的 globalStorage 路径上推（<User>/globalStorage/<publisher>.<name>）
 *      —— 这样在 portable / 远程 / 自定义 --user-data-dir 场景下也准确
 *   2. 平台默认位置兜底
 */
function findUserKeybindingsPath(context: vscode.ExtensionContext): string | null {
  const candidates: string[] = [];
  try {
    // context.globalStorageUri = file:///<User>/globalStorage/<publisher>.<name>
    const storageDir = context.globalStorageUri.fsPath.replace(/[\\/]+$/, '');
    const userDir = path.dirname(path.dirname(storageDir));
    candidates.push(path.join(userDir, 'keybindings.json'));
  } catch {
    /* 推导失败就用下面的兜底 */
  }

  const appData = process.env.APPDATA;
  if (appData) {
    candidates.push(path.join(appData, 'Code', 'User', 'keybindings.json'));
    candidates.push(path.join(appData, 'Code - Insiders', 'User', 'keybindings.json'));
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    candidates.push(path.join(home, '.config', 'Code', 'User', 'keybindings.json'));
    candidates.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'keybindings.json'));
  }

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        return c;
      }
    } catch {
      /* 忽略不可访问的候选 */
    }
  }
  return null;
}

/** 去掉 JSONC 的注释与尾随逗号，使其能被 JSON.parse 处理 */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === '\n') {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  // 尾随逗号
  return out.replace(/,(\s*[}\]])/g, '$1');
}

interface UserKeybindingEntry {
  key?: string;
  command?: string;
  win?: string;
  mac?: string;
  linux?: string;
}

/** 读取用户 keybindings.json，得到「命令 ID → 用户绑定键位」 */
function readUserKeybindings(file: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!file) {
    return map;
  }
  let entries: UserKeybindingEntry[];
  try {
    const parsed = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
    if (!Array.isArray(parsed)) {
      return map;
    }
    entries = parsed as UserKeybindingEntry[];
  } catch {
    return map;
  }

  const platformKey = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
  for (const e of entries) {
    if (!e || typeof e.command !== 'string' || typeof e.key !== 'string') {
      continue;
    }
    // 负号是"解绑"，不是绑定
    if (e.command.startsWith('-')) {
      continue;
    }
    const override = e[platformKey as keyof UserKeybindingEntry];
    const key = typeof override === 'string' && override ? override : e.key;
    if (!map.has(e.command)) {
      map.set(e.command, prettyKey(key));
    }
  }
  return map;
}

/**
 * 汇总已安装扩展贡献的命令/键位/显示名，以及用户自定义键位。
 * 全部走公开数据（扩展 packageJSON + 用户 keybindings.json）。
 */
function collectContributions(context: vscode.ExtensionContext): Contributions {
  const owners = new Map<string, string>();
  const namespaces = new Map<string, string>();
  const bareTitles = new Map<string, string>();
  const keys = new Map<string, string>();
  const extNames = new Map<string, string>();
  const userKeys = readUserKeybindings(findUserKeybindingsPath(context));

  for (const ext of vscode.extensions.all) {
    const pkg = ext.packageJSON as
      | {
          displayName?: string;
          name?: string;
          contributes?: {
            commands?: Array<{ command?: string; title?: string }>;
            keybindings?: ExtensionContribution[];
          };
        }
      | undefined;
    if (!pkg) {
      continue;
    }
    const rawDisplay = String(pkg.displayName || pkg.name || ext.id);
    // displayName 里可能出现未解析的本地化占位符（如 %ext.displayName%），退回包名
    const displayName = /%[a-zA-Z][a-zA-Z0-9_.]*%/.test(rawDisplay)
      ? String(pkg.name || ext.id)
      : rawDisplay;
    const ns = String(pkg.name || ext.id.split('.').pop() || '');
    extNames.set(ext.id.toLowerCase(), displayName);
    extNames.set(ns.toLowerCase(), displayName);

    // 语言包：把标题里的 %key% 解析成真实文案（中文优先，英文兜底）
    const nls = readNlsBundles(ext.extensionPath);

    for (const c of pkg.contributes?.commands ?? []) {
      if (typeof c?.command !== 'string') {
        continue;
      }
      if (!owners.has(c.command)) {
        owners.set(c.command, displayName);
        namespaces.set(c.command, ns);
      }
      if (typeof c.title === 'string' && !bareTitles.has(c.command)) {
        // 先解析语言包，再去掉 "扩展名: " 这种前缀，避免列表里重复
        const resolved = resolveNlsTitle(c.title, nls);
        if (resolved) {
          const stripped = resolved.replace(/^[^:：]{1,40}[:：]\s*/, '');
          const clean = stripped || resolved;
          if (clean.trim()) {
            bareTitles.set(c.command, clean);
          }
        }
      }
    }

    for (const kb of pkg.contributes?.keybindings ?? []) {
      if (typeof kb?.command !== 'string' || typeof kb?.key !== 'string') {
        continue;
      }
      // 跳过内部按键代理命令：没有标题，列出来只是一串 "gitlens.key.ctrl+right" 噪音
      if (KEY_PROXY_ID.test(kb.command) && !owners.has(kb.command)) {
        continue;
      }
      // ★ 只收键位，不改归属：很多扩展会给"别人的/内置的"命令声明键位
      //   （如 GitLens 给 workbench.view.scm 声明键位），据此认领来源会误判
      if (!keys.has(kb.command)) {
        keys.set(kb.command, prettyKey(kb.key));
      }
    }
  }

  return { owners, namespaces, bareTitles, keys, extNames, userKeys };
}

/** 标题里形如 %some.key% 的是扩展的本地化 key（未解析） */
const NLS_KEY = /%([a-zA-Z][a-zA-Z0-9_.]*)%/g;

/**
 * 读取扩展自带的语言包，用于把标题里的 %key% 解析成真实文字。
 * 很多扩展（LaTeX Workshop / Project Manager / Python …）把标题写成 %command.xxx%，
 * 由 package.nls.json 提供文案；不解析的话列表里只能显示这串 key。
 *
 * 返回候选包列表：中文包优先，英文包兜底（有的 key 只在其中一边存在）。
 */
function readNlsBundles(extRoot: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  for (const file of ['package.nls.zh-cn.json', 'package.nls.json']) {
    try {
      const p = path.join(extRoot, file);
      if (!fs.existsSync(p)) {
        continue;
      }
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, string>;
      if (parsed && typeof parsed === 'object') {
        out.push(parsed);
      }
    } catch {
      /* 语言包损坏就跳过，退回可读化处理 */
    }
  }
  return out;
}

/** 用单个语言包解析 %key%；有任何 key 缺失就返回 null */
function resolveWithBundle(title: string, bundle: Record<string, string>): string | null {
  NLS_KEY.lastIndex = 0;
  let allFound = true;
  const out = title.replace(NLS_KEY, (m, key: string) => {
    const v = bundle[key];
    if (typeof v === 'string') {
      return v;
    }
    allFound = false;
    return m;
  });
  return allFound ? out : null;
}

/** 把标题里的 %key% 尽量解析成真实文案；所有语言包都解析不出来则返回 null */
function resolveNlsTitle(title: string, bundles: Array<Record<string, string>>): string | null {
  NLS_KEY.lastIndex = 0;
  if (!NLS_KEY.test(title)) {
    return title; // 没有占位符，原样使用
  }
  for (const b of bundles) {
    const r = resolveWithBundle(title, b);
    if (r) {
      return r;
    }
  }
  return null;
}

function escapeHtml(s: string): string {  return String(s)
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
    return m === 'usage' || m === 'alpha' || m === 'source' ? (m as SortMode) : 'default';
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

    const con = collectContributions(this.context);
    const usage = this.usageMap();

    // 键位取值优先级：清单里显式写死的 > 用户自定义绑定 > 扩展声明的默认键位
    const keyOf = (command: string, explicit?: string): string | undefined =>
      explicit ? String(explicit) : con.userKeys.get(command) ?? con.keys.get(command);

    // 设置里的 commands 是任意 JSON，label/command 可能是 undefined 或非字符串，
    // 一律 String() 兜住，避免后续比较/排序抛异常
    const base: CommandItem[] = userCommands.length > 0 ? userCommands : DEFAULT_COMMANDS;
    const curated: DeckItem[] = base
      .filter((it) => it && it.command)
      .map((it) => ({
        label: String(it.label ?? it.command),
        command: String(it.command),
        keys: keyOf(String(it.command), it.keys),
        available: available.has(String(it.command))
      }));

    // ── 扩展命令：名字带"扩展显示名:"前缀，无正式标题则按 ID 可读化 ──
    // 迭代 con.keys 与 con.userKeys 的并集：有些命令只有你自定义的键位、扩展没声明
    const extras: DeckItem[] = [];
    if (includeExtensions) {
      const candidates = new Set<string>([...con.keys.keys(), ...con.userKeys.keys()]);
      for (const command of candidates) {
        // 只列"由某个扩展真正声明"的命令；只声明键位的不算，
        // 否则会把内置命令（如 workbench.view.scm）也当成扩展命令收进来
        if (!available.has(command) || !con.owners.has(command)) {
          continue;
        }
        const source = con.owners.get(command) ?? '';
        const bare =
          con.bareTitles.get(command) ?? humanizeCommandId(command, con.namespaces.get(command));
        extras.push({
          label: source ? `${source}: ${bare}` : bare,
          bare,
          source,
          command: String(command),
          keys: keyOf(command),
          available: true
        });
      }
      extras.sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'));
    }

    // ── 双向去重（内置清单优先）────────────────────────────────────────
    // ① 命令 ID 相同 → 保留内置那条
    // ② 键位相同 → 只保留第一个；但若某项是你"自定义绑定"的键位，则它优先，
    //    已有的同键位条目让位（否则你把某命令绑到已被占用的键上时会看不到它）
    const seenCommands = new Set<string>();
    const seenKeys = new Map<string, number>();
    const merged: DeckItem[] = [];
    for (const it of [...curated, ...extras]) {
      const cmd = String(it.command);
      if (seenCommands.has(cmd)) {
        continue;
      }
      const kb = it.keys ? String(it.keys) : '';
      const norm = kb ? kb.toLowerCase().replace(/\s+/g, ' ').trim() : '';
      const isUserBound = con.userKeys.has(cmd);
      if (norm && seenKeys.has(norm) && !isUserBound) {
        continue;
      }
      if (norm) {
        const prevIdx = seenKeys.get(norm);
        if (prevIdx !== undefined && isUserBound) {
          merged.splice(prevIdx, 1); // 让位给你的自定义绑定
          seenKeys.delete(norm);
        }
        seenKeys.set(norm, merged.length);
      }
      seenCommands.add(cmd);
      merged.push(it);
    }

    // 给没有来源的条目补来源：按命名空间反查（VS Code 内置命令有 vscode.xxx 形式的归属）
    for (const it of merged) {
      if (it.source) {
        continue;
      }
      const cmd = String(it.command).toLowerCase();
      const head = cmd.split('.')[0];
      if (head.length >= 3) {
        const owner = con.extNames.get(head);
        if (owner) {
          it.source = owner;
        }
      }
    }

    for (const it of merged) {
      it.usage = usage[it.command] ?? 0;
    }

    const mode = this.sortMode();
    if (mode === 'usage') {
      merged.sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0));
    } else if (mode === 'alpha') {
      merged.sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'));
    } else if (mode === 'source') {
      // 内置在最前，然后各扩展按显示名排序；组内按名称
      merged.sort((a, b) => {
        const sa = a.source ?? '';
        const sb = b.source ?? '';
        if (sa !== sb) {
          if (!sa) {
            return -1;
          }
          if (!sb) {
            return 1;
          }
          return sa.localeCompare(sb, 'zh-Hans-CN');
        }
        return String(a.bare ?? a.label).localeCompare(String(b.bare ?? b.label), 'zh-Hans-CN');
      });
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
      s: i.source ? String(i.source) : '',
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

  .sortrow { display: flex; align-items: center; gap: 5px; }
  .seg {
    display: flex;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
    border-radius: 4px;
    overflow: hidden;
  }
  .seg button {
    font: inherit;
    font-size: .82em;
    padding: 2px 8px;
    border: 0;
    border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    opacity: .8;
  }
  .seg button:last-child { border-right: 0; }
  .seg button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); opacity: 1; }
  .seg button.on {
    background: var(--vscode-list-activeSelectionBackground, rgba(128,128,128,.3));
    color: var(--vscode-list-activeSelectionForeground, inherit);
    opacity: 1;
  }
  #sortsel {
    font: inherit;
    font-size: .82em;
    padding: 2px 4px;
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    background: var(--vscode-dropdown-background, transparent);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, rgba(128,128,128,.4)));
    border-radius: 4px;
    outline: none;
  }
  .hint { font-size: .78em; opacity: .55; margin-left: auto; }

  /* 搜索行：输入框 + 清空按钮 */
  .searchrow { display: flex; align-items: center; gap: 4px; }
  .searchrow #q { flex: 1 1 auto; }
  .clearbtn {
    flex: 0 0 auto;
    font: inherit;
    line-height: 1;
    padding: 3px 7px;
    color: var(--vscode-foreground);
    background: transparent;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
    border-radius: 4px;
    cursor: pointer;
    opacity: .7;
  }
  .clearbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); opacity: 1; }

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

  /* 分组标题（按来源分组，或在扩展段开始处） */
  .grouphead {
    margin: 8px 4px 1px 4px;
    padding-top: 5px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    font-size: .8em;
    opacity: .62;
    text-transform: none;
  }
  .grouphead:first-child { border-top: 0; padding-top: 0; margin-top: 2px; }
  .empty { padding: 10px; opacity: .6; font-size: .9em; }
</style>
</head>
<body>
  <div class="toolbar">
    <div class="searchrow">
      <input id="q" type="text" placeholder="搜索命令或键位…" autocomplete="off" spellcheck="false" />
      <button class="clearbtn" id="clear" type="button" title="清空搜索">×</button>
    </div>
    <div class="sortrow">
      <select id="sortsel" title="排序方式"></select>
      <div class="seg" id="seg"></div>
      <span class="hint" id="hint"></span>
    </div>
  </div>
  <div class="list" id="list"></div>

<script nonce="${opts.nonce}">
  const vscode = acquireVsCodeApi();
  const DATA = ${payload};
  const SHOW_KEYS = ${opts.showKeys ? 'true' : 'false'};

  const MODES = ['default', 'usage', 'alpha', 'source'];
  const MODE_LABEL = {
    default: '默认顺序',
    usage: '按使用次数',
    alpha: '按名称',
    source: '按来源分组'
  };
  const SHORT = { default: '默认', usage: '常用', alpha: '名称', source: '来源' };
  let mode = DATA.sortMode || 'default';

  const q = document.getElementById('q');
  const list = document.getElementById('list');
  const sortSel = document.getElementById('sortsel');
  const seg = document.getElementById('seg');
  const hint = document.getElementById('hint');
  const clearBtn = document.getElementById('clear');
  let rows = [];
  let sel = 0;

  function updateClearBtn() {
    clearBtn.style.display = q.value ? '' : 'none';
  }

  function buildSortUi() {
    sortSel.textContent = '';
    MODES.forEach(function (m) {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = MODE_LABEL[m];
      if (m === mode) o.selected = true;
      sortSel.appendChild(o);
    });
    seg.textContent = '';
    MODES.forEach(function (m) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = SHORT[m];
      b.title = MODE_LABEL[m];
      if (m === mode) b.className = 'on';
      b.addEventListener('click', function () { setMode(m); });
      seg.appendChild(b);
    });
    const used = DATA.items.filter(function (i) { return (i.u || 0) > 0; }).length;
    // 始终显示总条数，便于判断"空列表"是数据为空还是搜索过滤掉了
    hint.textContent = mode === 'usage' ? ('已记录 ' + used + ' 条') : ('共 ' + DATA.items.length + ' 条');
  }

  function setMode(m) {
    if (m === mode) return;
    mode = m;
    buildSortUi();
    vscode.postMessage({ type: 'sort', mode: m });
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

  function render(items, grouped) {
    list.textContent = '';
    rows = [];
    let lastGroup = null;
    items.forEach(function (it) {
      const g = grouped ? (it.s || '内置命令') : (it.s ? '__ext__' : null);
      if (g && g !== lastGroup) {
        const head = document.createElement('div');
        head.className = 'grouphead';
        head.textContent = grouped ? g : '来自已安装扩展';
        list.appendChild(head);
        lastGroup = g;
      }
      const btn = makeRow(it);
      list.appendChild(btn);
      rows.push({ el: btn, item: it });
    });
    if (rows.length === 0) {
      const d = document.createElement('div');
      d.className = 'empty';
      const term = q.value.trim();
      d.textContent = DATA.items.length === 0
        ? '命令列表为空（扩展没取到任何命令，请查看扩展宿主日志）'
        : ('没有匹配「' + term + '」的命令（共 ' + DATA.items.length + ' 条，可点 × 清空搜索）');
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

  // 归一化：小写 + 去掉 "+" 周围空格 + 压掉所有空白。
  // 这样 ctrl+shift+s / Ctrl + Shift + S / CTRL+SHIFT+S 都能互相匹配
  function norm(s) {
    return String(s).toLowerCase().replace(/\s*\+\s*/g, '+').replace(/\s+/g, '');
  }

  function currentList() {
    const term = norm(q.value);
    if (!term) return DATA.items;
    return DATA.items.filter(function (it) {
      return norm(it.n + ' ' + it.c + ' ' + (it.k || '')).indexOf(term) >= 0;
    });
  }

  function redraw() {
    updateClearBtn();
    render(currentList(), mode === 'source' && !q.value.trim());
  }

  q.addEventListener('input', redraw);
  sortSel.addEventListener('change', function () { setMode(sortSel.value); });

  // 清空搜索：解决"上次输入的搜索词被 webview 保留，重载后列表看着是空的"
  clearBtn.addEventListener('click', function () {
    q.value = '';
    redraw();
    q.focus();
  });

  q.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); select(sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(sel - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const cur = rows[sel];
      if (cur) fire(cur.item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (q.value) { q.value = ''; redraw(); }
    }
  });

  // 前端初始化兜底：任何异常都画在页面上，而不是留一片空白让人猜
  function showFatal(msg) {
    try {
      const d = document.createElement('div');
      d.style.cssText = 'padding:10px;white-space:pre-wrap;font-family:monospace;font-size:12px;color:var(--vscode-foreground)';
      d.textContent = 'Command Deck 前端初始化失败：\n' + msg;
      document.body.appendChild(d);
    } catch (e) {
      document.body.textContent = 'Command Deck 初始化失败: ' + msg;
    }
  }

  try {
    if (!DATA || !Array.isArray(DATA.items)) {
      throw new Error('payload 异常：items 不是数组（' + JSON.stringify(DATA).slice(0, 120) + '）');
    }
    buildSortUi();
    redraw();
    q.focus();
  } catch (err) {
    showFatal(String((err && err.stack) || err));
  }
</script>
</body>
</html>`;
}
