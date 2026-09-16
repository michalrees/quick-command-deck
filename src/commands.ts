/**
 * 命令条目结构。
 *
 *   label   按钮/列表上显示的名称
 *   command 真正执行的命令 ID（走 vscode.commands.executeCommand）
 *   keys    默认键位，仅用于显示提示；用户改过键位也不影响点击执行
 */
export interface CommandItem {
  label: string;
  command: string;
  keys?: string;
}

/**
 * 内置命令清单。
 *
 * 说明：VS Code **没有**公开 API 能查询某个命令的默认键位（默认键位表是编译进
 * bundle 的私有格式），所以这里的 keys 是人工维护的。改键位不影响执行，
 * 只影响这里显示的提示文字。
 *
 * 用户可用设置 quickCommandDeck.commands 覆盖这份清单（留空则用内置的）。
 */
export const DEFAULT_COMMANDS: CommandItem[] = [
  // ── 导航 ───────────────────────────────────────────────
  { label: '转到文件', command: 'workbench.action.quickOpen', keys: 'Ctrl+P' },
  { label: '转到行/列', command: 'workbench.action.gotoLine', keys: 'Ctrl+G' },
  { label: '转到符号', command: 'workbench.action.gotoSymbol', keys: 'Ctrl+Shift+O' },
  { label: '转到定义', command: 'editor.action.revealDefinition', keys: 'F12' },
  { label: '全局搜索', command: 'workbench.action.findInFiles', keys: 'Ctrl+Shift+F' },

  // ── 编辑 ───────────────────────────────────────────────
  { label: '命令面板', command: 'workbench.action.showCommands', keys: 'Ctrl+Shift+P' },
  { label: '快速修复', command: 'editor.action.quickFix', keys: 'Ctrl+.' },
  { label: '重命名符号', command: 'editor.action.rename', keys: 'F2' },
  { label: '格式化文档', command: 'editor.action.formatDocument', keys: 'Ctrl+Shift+I' },
  { label: '查找替换', command: 'editor.action.startFindReplaceAction', keys: 'Ctrl+H' },
  { label: '切换注释', command: 'editor.action.commentLine', keys: 'Ctrl+/' },
  { label: '复制行', command: 'editor.action.copyLinesDownAction', keys: 'Ctrl+Shift+D' },
  { label: '删除行', command: 'editor.action.deleteLines', keys: 'Ctrl+Shift+K' },
  { label: '上移行', command: 'editor.action.moveLinesUpAction', keys: 'Alt+Up' },
  { label: '下移行', command: 'editor.action.moveLinesDownAction', keys: 'Alt+Down' },
  { label: '保存文件', command: 'workbench.action.files.save', keys: 'Ctrl+S' },
  { label: '全部保存', command: 'workbench.action.files.saveAll', keys: 'Ctrl+K Ctrl+S' },
  { label: '撤销', command: 'undo', keys: 'Ctrl+Z' },
  { label: '重做', command: 'redo', keys: 'Ctrl+Y' },

  // ── 视图 / 窗口 ────────────────────────────────────────
  { label: '全屏', command: 'workbench.action.toggleFullScreen', keys: 'F11' },
  { label: '禅模式', command: 'workbench.action.toggleZenMode', keys: 'Ctrl+Alt+Z' },
  { label: '切换终端', command: 'workbench.action.terminal.toggleTerminal', keys: 'Ctrl+`' },
  { label: '新建终端', command: 'workbench.action.terminal.new', keys: 'Ctrl+Shift+`' },
  { label: '切换侧边栏', command: 'workbench.action.toggleSidebarVisibility', keys: 'Ctrl+B' },
  { label: '切换面板', command: 'workbench.action.togglePanel', keys: 'Ctrl+J' },
  { label: '拆分编辑器', command: 'workbench.action.splitEditor', keys: 'Ctrl+\\' },
  { label: '关闭编辑器', command: 'workbench.action.closeActiveEditor', keys: 'Ctrl+W' },
  { label: '关闭所有编辑器', command: 'workbench.action.closeAllEditors', keys: 'Ctrl+K Ctrl+W' },
  { label: '打开聊天', command: 'workbench.action.chat.open', keys: 'Ctrl+Alt+I' },
  { label: '源代码管理', command: 'workbench.view.scm', keys: 'Ctrl+Shift+G' },
  { label: '扩展', command: 'workbench.view.extensions', keys: 'Ctrl+Shift+X' },
  { label: '资源管理器', command: 'workbench.view.explorer', keys: 'Ctrl+Shift+E' },
  { label: '调试', command: 'workbench.view.debug', keys: 'Ctrl+Shift+D' },
  { label: '打开设置', command: 'workbench.action.openSettings', keys: 'Ctrl+,' },
  { label: '键盘快捷方式', command: 'workbench.action.openGlobalKeybindings', keys: 'Ctrl+K Ctrl+S' },
  { label: '新建窗口', command: 'workbench.action.newWindow', keys: 'Ctrl+Shift+N' }
];
