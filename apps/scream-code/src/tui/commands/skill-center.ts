/**
 * /skill — ScreamCode Skill 中心。
 *
 * 上方列出当前会话已安装且可手动激活的 Skill；下方列出可安装的 Skill 包。
 * - Enter：激活已安装 Skill / 安装并注入可安装包
 * - d：卸载已安装 Skill（插件包来源调用 removePlugin，手动安装则删除安装目录及子 Skill）
 * - i：安装并注入可安装包（安装后立即激活首个 Skill，多 Skill 时弹出选择）
 *
 * 系统级 Skill（如 /dream、/make-skill）不会出现在列表中。
 */

import type { PluginSummary, SkillSummary } from '@scream-cli/scream-code-sdk';
import { Container, matchesKey, Key, Spacer, type Focusable } from '@earendil-works/pi-tui';
import chalk from 'chalk';

import { loadPluginMarketplace, type PluginMarketplaceEntry } from '#/utils/plugin-marketplace';

import { ChoicePickerComponent, type ChoiceOption } from '../components/dialogs/choice-picker';
import type { SlashCommandHost } from './dispatch';
import { MoonLoader } from '../components/chrome/moon-loader';
import { FALLBACK_SKILL_MARKETPLACE, type FallbackMarketplaceEntry } from './skill-marketplace';
import { isUserActivatableSkill } from './skills';

const SKILL_DESC_MAX = 60;

type MarketplaceEntry = PluginMarketplaceEntry | FallbackMarketplaceEntry;

export async function handleSkillCommand(
  host: SlashCommandHost,
  _args: string,
): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError('请先创建或恢复一个会话，再使用 Skill 中心。');
    return;
  }
  await openSkillCenter(host);
}

async function openSkillCenter(host: SlashCommandHost): Promise<void> {
  const loading = new SkillCenterLoadingComponent(host, '正在加载 Skill 中心…');
  host.mountEditorReplacement(loading);

  const [skillsResult, pluginsResult, marketplaceResult] = await Promise.allSettled([
    loadActivatableSkills(host),
    loadInstalledPlugins(host),
    loadMarketplace(host),
  ]);

  loading.stop();

  const skills = skillsResult.status === 'fulfilled' ? skillsResult.value : [];
  const plugins = pluginsResult.status === 'fulfilled' ? pluginsResult.value : [];
  const marketplace = marketplaceResult.status === 'fulfilled' ? marketplaceResult.value : [];

  if (loading.isCancelled()) {
    return;
  }

  const options = buildOptions(host, skills, plugins, marketplace);
  if (options.length === 0) {
    host.restoreEditor();
    host.showNotice('Skill 中心', '当前没有已安装 Skill 也没有可安装 Skill 包。');
    return;
  }

  const picker = new ChoicePickerComponent({
    title: 'Skill 中心',
    hint: 'Enter 激活/安装 · d 卸载 · i 安装并注入 · Esc 返回',
    options,
    colors: host.state.theme.colors,
    searchable: true,
    pageSize: 10,
    onSelect: (value: string) => {
      host.restoreEditor();
      void handleSelect(host, value, skills, plugins, marketplace);
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}
// ─── Loading overlay ───────────────────────────────────────────────────────

class SkillCenterLoadingComponent extends Container implements Focusable {
  focused = false;
  private readonly loader: MoonLoader;
  private readonly host: SlashCommandHost;
  private cancelled = false;

  constructor(
    host: SlashCommandHost,
    private readonly label: string,
  ) {
    super();
    this.host = host;
    const tint = (s: string): string => chalk.hex(host.state.theme.colors.primary)(s);
    this.loader = new MoonLoader(host.state.ui, 'braille', tint, this.label);
    this.addChild(new Spacer(1));
    this.addChild(this.loader);
  }

  handleInput(data: string): void {
    // Esc cancels the loading overlay and returns to the editor.
    if (matchesKey(data, Key.escape)) {
      this.cancelled = true;
      this.stop();
      this.host.restoreEditor();
    }
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  stop(): void {
    this.loader.stop();
  }
}
async function loadActivatableSkills(host: SlashCommandHost): Promise<readonly SkillSummary[]> {
  const session = host.session;
  if (!session) return [];
  try {
    const all = await session.listSkills();
    return all.filter((skill) => isUserActivatableSkill(skill) && skill.source !== 'builtin');
  } catch {
    return [];
  }
}

async function loadInstalledPlugins(host: SlashCommandHost): Promise<readonly PluginSummary[]> {
  const session = host.session;
  if (!session) return [];
  try {
    // /make-skill writes generated plugins directly to disk, so refresh before showing.
    await session.reloadPlugins().catch(() => {
      /* ignore reload errors */
    });
    return await session.listPlugins();
  } catch {
    return [];
  }
}

async function loadMarketplace(host: SlashCommandHost): Promise<readonly MarketplaceEntry[]> {
  try {
    const { plugins } = await loadPluginMarketplace({
      workDir: host.state.appState.workDir,
    });
    return plugins;
  } catch {
    return [...FALLBACK_SKILL_MARKETPLACE];
  }
}

function buildOptions(
  host: SlashCommandHost,
  skills: readonly SkillSummary[],
  plugins: readonly PluginSummary[],
  marketplace: readonly MarketplaceEntry[],
): ChoiceOption[] {
  const options: ChoiceOption[] = [];

  if (skills.length > 0) {
    options.push({
      value: '__section__installed',
      label: '── 已安装的 Skill ──',
    });
    for (const skill of skills) {
      const actionKeys: Record<string, () => void> = {};
      if (skill.pluginId !== undefined) {
        actionKeys['d'] = () => {
          host.restoreEditor();
          void uninstallByPluginId(host, skill.pluginId!);
        };
      } else {
        actionKeys['d'] = () => {
          host.restoreEditor();
          void uninstallManualSkill(host, skill);
        };
      }
      options.push({
        value: `activate:${skill.name}`,
        label: skill.name,
        description: formatSkillDescription(skill),
        actionKeys,
      });
    }
  }

  const installedIds = new Set(plugins.map((p) => p.id));
  const installable = marketplace.filter((entry) => !installedIds.has(entry.id));
  if (installable.length > 0) {
    options.push({
      value: '__section__installable',
      label: '── 可安装的 Skill 包 ──',
    });
    for (const entry of installable) {
      options.push({
        value: `install:${entry.source}`,
        label: entry.displayName,
        description: entry.description
          ? `${truncate(entry.description, SKILL_DESC_MAX)}  [未安装]`
          : '[未安装]',
        actionKeys: {
          i: () => {
            host.restoreEditor();
            void installInjectActivate(host, entry.source);
          },
        },
      });
    }
  }

  return options;
}

async function handleSelect(
  host: SlashCommandHost,
  value: string,
  skills: readonly SkillSummary[],
  _plugins: readonly PluginSummary[],
  _marketplace: readonly MarketplaceEntry[],
): Promise<void> {
  if (value.startsWith('__section')) {
    // Selecting a section header just refreshes the panel.
    await openSkillCenter(host);
    return;
  }
  if (value.startsWith('activate:')) {
    const name = value.slice('activate:'.length);
    await activateSkillByName(host, name, skills);
    return;
  }
  if (value.startsWith('install:')) {
    const source = value.slice('install:'.length);
    await installInjectActivate(host, source);
    return;
  }
  // Unknown value — refresh so the UI doesn't get stuck.
  await openSkillCenter(host);
}

async function activateSkillByName(
  host: SlashCommandHost,
  name: string,
  skills: readonly SkillSummary[],
): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError('未连接到会话。请先创建或恢复一个会话。');
    return;
  }
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    host.showError(`未找到 Skill "${name}"。`);
    return;
  }
  host.sendSkillActivation(session, skill.name, '');
}

async function installInjectActivate(host: SlashCommandHost, source: string): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError('未连接到会话。请先创建或恢复一个会话。');
    return;
  }

  const spinner = host.showProgressSpinner('正在安装 Skill 包…');
  try {
    const summary = await session.installPlugin(source);
    await session.injectPlugin(summary.id);
    spinner.stop({ ok: true, label: `"${summary.displayName}" 已安装并注入当前会话。` });
    const allSkills = await session.listSkills();
    const pluginSkills = allSkills.filter(
      (s) => s.pluginId === summary.id && isUserActivatableSkill(s),
    );
    if (pluginSkills.length === 0) {
      host.showNotice(
        '插件已安装',
        `${summary.displayName} 已成功安装，但该包没有可手动激活的 Skill。`,
      );
      return;
    }
    if (pluginSkills.length === 1) {
      const first = pluginSkills[0]!;
      host.sendSkillActivation(session, first.name, '');
      return;
    }
    await pickAndActivateSkill(host, pluginSkills);
  } catch (error) {
    spinner.stop({ ok: false, label: '安装失败。' });
    host.showError(`安装失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}


async function pickAndActivateSkill(
  host: SlashCommandHost,
  skills: readonly SkillSummary[],
): Promise<void> {
  const session = host.session;
  if (!session) return;

  const options: ChoiceOption[] = skills.map((skill) => ({
    value: skill.name,
    label: skill.name,
    description: formatSkillDescription(skill),
  }));

  const picker = new ChoicePickerComponent({
    title: '选择一个 Skill 激活',
    hint: 'Enter 激活 · Esc 返回',
    options,
    colors: host.state.theme.colors,
    searchable: true,
    pageSize: 8,
    onSelect: (value: string) => {
      host.restoreEditor();
      host.sendSkillActivation(session, value, '');
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });

  host.mountEditorReplacement(picker);
}

async function uninstallByPluginId(host: SlashCommandHost, pluginId: string): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError('未连接到会话。请先创建或恢复一个会话。');
    return;
  }

  let plugins: readonly PluginSummary[] = [];
  try {
    plugins = await session.listPlugins();
  } catch {
    // Proceed with id as label if plugin list is unavailable.
  }
  const plugin = plugins.find((p) => p.id === pluginId);
  const label = plugin?.displayName ?? pluginId;

  const confirmed = await confirmUninstall(host, label);
  if (!confirmed) {
    await openSkillCenter(host);
    return;
  }

  const spinner = host.showProgressSpinner(`正在卸载 "${label}"…`);
  try {
    await session.removePlugin(pluginId);
    spinner.stop({ ok: true, label: `"${label}" 已卸载。` });
    host.showNotice(
      '插件已卸载',
      '该插件的 Skill 已从当前会话中移除，无需重启会话。',
    );
  } catch (error) {
    spinner.stop({ ok: false, label: '卸载失败。' });
    host.showError(`卸载失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await openSkillCenter(host);
  }
}

async function uninstallManualSkill(host: SlashCommandHost, skill: SkillSummary): Promise<void> {
  const session = host.session;
  if (!session) {
    host.showError('未连接到会话。请先创建或恢复一个会话。');
    return;
  }

  const confirmed = await confirmUninstall(
    host,
    skill.name,
    '将删除该 Skill 的安装目录及子 Skill',
  );
  if (!confirmed) {
    await openSkillCenter(host);
    return;
  }

  const spinner = host.showProgressSpinner(`正在删除 "${skill.name}"…`);
  try {
    await session.removeSkill(skill.name);
    spinner.stop({ ok: true, label: `"${skill.name}" 已删除。` });
    host.showNotice('Skill 已删除', '该 Skill 及其子 Skill 已从当前会话中移除。');
  } catch (error) {
    spinner.stop({ ok: false, label: '删除失败。' });
    host.showError(`删除失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await openSkillCenter(host);
  }
}

async function confirmUninstall(
  host: SlashCommandHost,
  label: string,
  description?: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const picker = new ChoicePickerComponent({
      title: `确认卸载 "${label}"？`,
      hint: '卸载后可在 Skill 中心重新安装',
      options: [
        { value: 'no', label: '取消' },
        { value: 'yes', label: '是，卸载', tone: 'danger', description },
      ],
      colors: host.state.theme.colors,
      onSelect: (value: string) => {
        host.restoreEditor();
        resolve(value === 'yes');
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(false);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

function formatSkillDescription(skill: SkillSummary): string {
  const parts: string[] = [];
  if (skill.source) {
    parts.push(`来源: ${skill.source}`);
  }
  if (skill.pluginId !== undefined) {
    parts.push(`插件: ${skill.pluginId}`);
  }
  if (skill.description) {
    parts.push(truncate(skill.description, SKILL_DESC_MAX));
  }
  return parts.join('  ·  ');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
