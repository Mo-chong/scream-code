import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { SlashCommandHost } from './dispatch';
import {
  getTuiConfigPath,
  loadTuiConfig,
  saveTuiConfig,
  type TuiConfig,
  type TuiLikePreferences,
} from '../config';
import { TextInputDialogComponent } from '../components/dialogs/text-input-dialog';
import { getDataDir } from '#/utils/paths';

function promptTextInput(
  host: SlashCommandHost,
  title: string,
  opts?: { subtitle?: string; placeholder?: string; initialValue?: string; allowEmpty?: boolean },
): Promise<string | undefined> {
  const { promise, resolve } = Promise.withResolvers<string | undefined>();
  const dialog = new TextInputDialogComponent(
    (result) => {
      host.restoreEditor();
      resolve(result.kind === 'ok' ? result.value : undefined);
    },
    {
      title,
      subtitle: opts?.subtitle,
      placeholder: opts?.placeholder,
      initialValue: opts?.initialValue,
      allowEmpty: opts?.allowEmpty,
      colors: host.state.theme.colors,
    },
  );
  host.mountEditorReplacement(dialog);
  return promise;
}

export function buildRoleAdditionalText(prefs: TuiLikePreferences): string {
  const parts: string[] = [];
  if (prefs.nickname !== undefined && prefs.nickname.trim().length > 0) {
    parts.push(`The user's preferred nickname is "${prefs.nickname.trim()}".`);
  }
  if (prefs.tone !== undefined && prefs.tone.trim().length > 0) {
    parts.push(`Respond in a ${prefs.tone.trim()} tone.`);
  }
  if (prefs.other !== undefined && prefs.other.trim().length > 0) {
    parts.push(`Additional user preferences: ${prefs.other.trim()}`);
  }
  return parts.join('\n');
}

async function getUserPrefsPath(): Promise<string> {
  return join(getDataDir(), 'user-prefs.md');
}

async function persistLikePreferences(
  host: SlashCommandHost,
  prefs: TuiLikePreferences,
): Promise<void> {
  const configPath = getTuiConfigPath();
  const current = await loadTuiConfig(configPath);
  const updated: TuiConfig = {
    ...current,
    like: prefs,
  };
  await saveTuiConfig(updated, configPath);

  const roleAdditional = buildRoleAdditionalText(prefs);
  await writeFile(await getUserPrefsPath(), roleAdditional, 'utf-8');

  host.setAppState({ like: prefs });
}

export async function handleLikeCommand(host: SlashCommandHost): Promise<void> {
  const current = host.state.appState.like ?? {};

  const nickname = await promptTextInput(host, '设置昵称', {
    subtitle: '你希望我怎么称呼你？留空表示不设置。',
    placeholder: '例如：Alex',
    initialValue: current.nickname,
    allowEmpty: true,
  });
  if (nickname === undefined) {
    host.showStatus('已取消 /like 设置', host.state.theme.colors.textDim);
    return;
  }

  const tone = await promptTextInput(host, '设置回应语气', {
    subtitle: '例如：友好、专业、幽默、简洁等（留空表示不设置）',
    placeholder: '例如：友好而专业',
    initialValue: current.tone,
    allowEmpty: true,
  });
  if (tone === undefined) {
    host.showStatus('已取消 /like 设置', host.state.theme.colors.textDim);
    return;
  }

  const other = await promptTextInput(host, '其他偏好', {
    subtitle: '例如：多说例子、先给结论再展开、避免术语等（留空表示不设置）',
    placeholder: '例如：请用中文回答，避免缩写',
    initialValue: current.other,
    allowEmpty: true,
  });
  if (other === undefined) {
    host.showStatus('已取消 /like 设置', host.state.theme.colors.textDim);
    return;
  }

  const prefs: TuiLikePreferences = {
    nickname: nickname.trim().length > 0 ? nickname.trim() : undefined,
    tone: tone.trim().length > 0 ? tone.trim() : undefined,
    other: other.trim().length > 0 ? other.trim() : undefined,
  };

  await persistLikePreferences(host, prefs);
  host.showStatus('偏好已保存（下次新会话生效）', host.state.theme.colors.success);
}
