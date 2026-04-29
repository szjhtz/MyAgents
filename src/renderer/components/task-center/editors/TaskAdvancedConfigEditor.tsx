// TaskAdvancedConfigEditor — collapsible "高级配置" block shared by the
// task dispatch dialog and the task edit panel.
//
// Default semantics: every field is `undefined` (== "跟随 Agent 工作区当前
// 配置"). The user opts in per field by picking a concrete value, which
// snapshots that value onto the Task. PRD 0.2.4 §需求 4.
//
// Permission-mode default has special meaning: when left at "跟随默认", the
// task executor uses the runtime's *maximum* permission (e.g. SDK builtin
// → bypassPermissions). This is intentional — task dispatch is unattended
// by definition, so a task that lands in `auto` mode would block at the
// first tool call waiting for confirmation that nobody is around to give.
// The cron execute path has long hardcoded `'fullAgency'` for this reason
// (see `src/server/index.ts` `/cron/execute`); the field surfaced here is
// the user-facing escape hatch when they want a stricter mode.

import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, Settings2 } from 'lucide-react';
import CustomSelect from '@/components/CustomSelect';
import { useConfig } from '@/hooks/useConfig';
import {
  RUNTIME_DISPLAY_NAMES,
  VALID_RUNTIMES,
  getRuntimePermissionModes,
  type RuntimeType,
} from '@/../shared/types/runtime';
import { PERMISSION_MODES } from '@/config/types';
import type { McpServerDefinition } from '@/config/types';

// "跟随" sentinel: an empty-string value selected from <CustomSelect>
// translates back to `undefined` on the wrapper level. Using `''` rather
// than a different sentinel keeps the option compatible with the existing
// `<CustomSelect value={…}>` contract (which doesn't tolerate `undefined`).
const FOLLOW_VALUE = '';

interface Props {
  /** Workspace path the task is bound to — used to resolve the workspace's
   *  provider so the model picker can populate from the right model list,
   *  and as a hint in placeholder copy (e.g. "跟随 Agent 工作区当前模型"). */
  workspacePath?: string;
  /** Optional display label for the workspace (used in hint copy when
   *  `workspacePath` doesn't resolve to a known project). */
  workspaceLabel?: string;

  // ─── Runtime / model / permission mode ───────────────────────────────
  runtime?: RuntimeType;
  setRuntime: (v: RuntimeType | undefined) => void;
  model?: string;
  setModel: (v: string | undefined) => void;
  permissionMode?: string;
  setPermissionMode: (v: string | undefined) => void;

  // ─── MCP enable list ─────────────────────────────────────────────────
  /** `undefined` = follow Agent. `[]` = explicitly run with no MCP servers. */
  mcpEnabledServers?: string[];
  setMcpEnabledServers: (v: string[] | undefined) => void;
}

export function TaskAdvancedConfigEditor(props: Props) {
  const {
    workspacePath,
    workspaceLabel,
    runtime,
    setRuntime: setRuntimeRaw,
    model,
    setModel,
    permissionMode,
    setPermissionMode,
    mcpEnabledServers,
    setMcpEnabledServers,
  } = props;

  // Wrap `setRuntime` so switching to a non-builtin runtime *also* clears
  // model + MCP overrides — those fields are SDK-builtin-only (the UI hides
  // them for external runtimes). Without the cleanup, a user who picks
  // builtin → enters `claude-sonnet-4-6` → switches to codex would persist
  // a stale model that the codex runtime can't resolve, leading to silent
  // execution failure. This is a structural guarantee (cleanup happens at
  // the only entry point that changes runtime) rather than a convention.
  const setRuntime = useCallback(
    (next: RuntimeType | undefined) => {
      const isBuiltinNext = (next ?? 'builtin') === 'builtin';
      setRuntimeRaw(next);
      if (!isBuiltinNext) {
        if (model !== undefined) setModel(undefined);
        if (mcpEnabledServers !== undefined) setMcpEnabledServers(undefined);
      }
    },
    [setRuntimeRaw, setModel, setMcpEnabledServers, model, mcpEnabledServers],
  );

  // Default-collapsed; expand state is local to the panel lifecycle.
  // Auto-expand if any value is already set (so "edit existing override"
  // doesn't hide what the user previously configured).
  const hasAnyOverride =
    runtime !== undefined
    || (model && model.length > 0)
    || (permissionMode && permissionMode.length > 0)
    || mcpEnabledServers !== undefined;
  const [open, setOpen] = useState<boolean>(hasAnyOverride);

  const { config, projects, providers } = useConfig();

  // Resolve the workspace's provider so we can populate the model picker
  // with the same model list the chat sidebar uses.
  //
  // Fallback chain (mirrors Launcher.tsx and App.tsx for legacy projects):
  //   project.providerId → config.defaultProviderId → null
  //
  // Legacy projects (created before per-project provider was introduced)
  // have providerId === null; those rely on the global default and we
  // surface its model list so the picker still works for them.
  const workspaceProvider = useMemo(() => {
    if (!workspacePath) return null;
    const project = projects.find((p) => p.path === workspacePath);
    const providerId = project?.providerId ?? config?.defaultProviderId ?? null;
    if (!providerId) return null;
    return providers.find((p) => p.id === providerId) ?? null;
  }, [workspacePath, projects, providers, config]);

  // Display label for "跟随 Agent" — what model does the workspace
  // currently use? Reuses the same precedence the chat-side picker uses:
  // project.model (per-workspace override) > provider.primaryModel (default).
  const workspaceProject = useMemo(() => {
    if (!workspacePath) return null;
    return projects.find((p) => p.path === workspacePath) ?? null;
  }, [workspacePath, projects]);
  const workspaceDefaultModel =
    workspaceProject?.model || workspaceProvider?.primaryModel || '';

  const modelOptions = useMemo(() => {
    if (!workspaceProvider) return [{ value: FOLLOW_VALUE, label: '跟随 Agent 工作区' }];
    const opts = [
      {
        value: FOLLOW_VALUE,
        label: workspaceDefaultModel
          ? `跟随 Agent（当前 ${workspaceDefaultModel}）`
          : '跟随 Agent 工作区',
      },
      ...workspaceProvider.models.map((m) => ({
        value: m.model,
        label: m.modelName ? `${m.modelName} · ${m.model}` : m.model,
      })),
    ];
    // Surface a previously-set model that isn't in the catalogue (legacy /
    // hand-typed) so the user can see and clear it without it silently
    // appearing as "跟随 Agent" in the dropdown.
    if (model && !workspaceProvider.models.some((m) => m.model === model)) {
      opts.push({ value: model, label: `其他：${model}` });
    }
    return opts;
  }, [workspaceProvider, workspaceDefaultModel, model]);

  // MCP catalogue — user's installed servers plus presets that are bundled.
  // Presets that are filtered by platform on the renderer side already get
  // pruned by `config.mcpServers`; we don't need to reproduce that gate.
  // Use `config` as the memo dep to satisfy React Compiler's preserve-memo
  // check; `config` is structurally stable across renders unless the user
  // actually mutates settings, which is exactly when we want to recompute.
  const mcpCatalogue: McpServerDefinition[] = useMemo(() => {
    const list = Array.isArray(config?.mcpServers) ? config.mcpServers : [];
    return [...list].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  }, [config]);

  const runtimeOptions = useMemo(
    () => [
      { value: FOLLOW_VALUE, label: '跟随 Agent 工作区' },
      ...VALID_RUNTIMES.map((r) => ({
        value: r,
        label: RUNTIME_DISPLAY_NAMES[r],
      })),
    ],
    [],
  );

  // Permission-mode options pivot on the active runtime. When the user
  // hasn't picked one (still inheriting from Agent), default the option
  // list to the SDK builtin set — that's what 90% of agents run.
  const permissionOptions = useMemo(() => {
    const effectiveRuntime: RuntimeType = (runtime ?? 'builtin') as RuntimeType;
    const modes = getRuntimePermissionModes(effectiveRuntime);
    if (effectiveRuntime === 'builtin') {
      // Builtin uses the trio from `PERMISSION_MODES` (auto/plan/fullAgency)
      // for label consistency with the chat UI.
      return [
        { value: FOLLOW_VALUE, label: '跟随默认（最大权限）' },
        ...PERMISSION_MODES.map((m) => ({
          value: m.value,
          label: `${m.label} · ${m.description}`,
        })),
      ];
    }
    return [
      { value: FOLLOW_VALUE, label: '跟随默认（最大权限）' },
      ...modes.map((m) => ({
        value: m.value,
        label: m.description ? `${m.label} · ${m.description}` : m.label,
      })),
    ];
  }, [runtime]);

  const isBuiltin = (runtime ?? 'builtin') === 'builtin';

  // Toggle a single MCP server in the override list (PRD 0.2.4 §需求 4).
  //
  // Two-state model — "follow Agent" (`undefined`) vs. "override with this
  // explicit list" (`[a, b, ...]`). Dropping the last item collapses back
  // to `undefined` so an emptied list never lingers as a meaningless
  // "explicit empty" — Rust's `update` treats `Some(vec![])` as a clear
  // anyway, so collapsing here keeps the wire/storage shapes 1:1.
  const toggleMcp = (id: string) => {
    if (mcpEnabledServers === undefined) {
      setMcpEnabledServers([id]);
      return;
    }
    if (mcpEnabledServers.includes(id)) {
      const next = mcpEnabledServers.filter((s) => s !== id);
      // Last item dropped → revert to "follow Agent" rather than
      // persisting `[]` (which the backend coerces to follow anyway).
      setMcpEnabledServers(next.length === 0 ? undefined : next);
    } else {
      setMcpEnabledServers([...mcpEnabledServers, id]);
    }
  };

  const resetMcpToFollow = () => setMcpEnabledServers(undefined);

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--line-subtle)] bg-[var(--paper-inset)]/50">
      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-4 py-2.5 text-left transition-colors hover:bg-[var(--hover-bg)]"
        aria-expanded={open}
      >
        <Settings2 className="h-4 w-4 text-[var(--ink-muted)]" strokeWidth={1.5} />
        <span className="flex-1 text-[13px] font-medium text-[var(--ink)]">
          高级配置
          <span className="ml-1.5 text-[12px] font-normal text-[var(--ink-muted)]">
            （可选 — 覆盖本次任务的 runtime / 模型 / 权限 / MCP）
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="space-y-5 border-t border-[var(--line-subtle)] px-4 py-4">
          {/* Runtime */}
          <FieldRow
            label="Runtime"
            hint={
              workspaceLabel
                ? `不选择时跟随 ${workspaceLabel} 当前 runtime`
                : '不选择时跟随 Agent 工作区当前 runtime'
            }
          >
            <CustomSelect
              value={runtime ?? FOLLOW_VALUE}
              options={runtimeOptions}
              onChange={(v) => setRuntime(v ? (v as RuntimeType) : undefined)}
              placeholder="跟随 Agent 工作区"
            />
          </FieldRow>

          {/* Model — only meaningful when builtin runtime is in play.
              External runtimes resolve their own model from the runtime
              process, so we hide this field rather than pretend it's
              actionable. The picker pulls models from the workspace's
              provider (set in workspace settings), so cross-provider
              overrides aren't possible here — by design, since per-task
              provider switching is a far more invasive change than v0.2.4
              targets. */}
          {isBuiltin && (
            <FieldRow
              label="模型"
              hint="不选择时跟随 Agent 当前模型；选择后强制使用该模型"
            >
              {workspaceProvider ? (
                <CustomSelect
                  value={model ?? FOLLOW_VALUE}
                  options={modelOptions}
                  onChange={(v) => setModel(v ? v : undefined)}
                  placeholder="跟随 Agent 工作区"
                />
              ) : (
                <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--line)] px-3 py-2 text-[12px] text-[var(--ink-muted)]">
                  工作区未配置 provider — 请先在工作区设置中选择一个 provider 才能在此覆盖模型
                </div>
              )}
            </FieldRow>
          )}

          {/* Permission mode */}
          <FieldRow
            label="权限模式"
            hint="不选择时使用所选 runtime 的最大权限（默认 bypassPermissions），适合无人值守任务"
          >
            <CustomSelect
              value={permissionMode ?? FOLLOW_VALUE}
              options={permissionOptions}
              onChange={(v) => setPermissionMode(v ? v : undefined)}
              placeholder="跟随默认（最大权限）"
            />
          </FieldRow>

          {/* MCP enable list */}
          {isBuiltin && (
            <FieldRow
              label="MCP 工具"
              hint={
                mcpEnabledServers === undefined
                  ? '当前跟随 Agent 工作区的 MCP 启用列表'
                  : `当前启用 ${mcpEnabledServers.length} 个 MCP 工具`
              }
            >
              {mcpCatalogue.length === 0 ? (
                <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--line)] px-3 py-3 text-[12px] text-[var(--ink-muted)]">
                  尚未在「设置 → MCP 工具」中安装任何 MCP，无法在此覆盖。
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {mcpCatalogue.map((s) => {
                      const checked = mcpEnabledServers
                        ? mcpEnabledServers.includes(s.id)
                        : false; // pristine = visually unchecked, label says "跟随"
                      return (
                        <label
                          key={s.id}
                          className={`flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border border-transparent px-2 py-1 text-[12px] text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] ${
                            checked
                              ? 'border-[var(--accent-warm)]/30 bg-[var(--accent-warm-subtle)] text-[var(--ink)]'
                              : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleMcp(s.id)}
                            className="h-3.5 w-3.5 accent-[var(--accent-warm)]"
                          />
                          <span className="truncate">{s.name}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-[11px]">
                    <button
                      type="button"
                      onClick={resetMcpToFollow}
                      disabled={mcpEnabledServers === undefined}
                      className="text-[var(--ink-muted)] hover:text-[var(--accent-warm)] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      恢复跟随 Agent
                    </button>
                  </div>
                </>
              )}
            </FieldRow>
          )}
        </div>
      )}
    </div>
  );
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-[var(--ink-secondary)]">
          {label}
        </span>
      </div>
      {children}
      {hint && (
        <p className="mt-1.5 text-[12px] leading-snug text-[var(--ink-muted)]">
          {hint}
        </p>
      )}
    </div>
  );
}

export default TaskAdvancedConfigEditor;
