// 自用策略：把补丁分成三层，默认只应用"不改安全边界"的两层。
//
// 上游把 80+ 条补丁打包成 ALL_PATCHES 一次性应用，其中一部分不是"让模型少啰嗦"，
// 而是真的拆掉 DSH 的拦截：审批引擎、文件系统围栏、沙箱 confine、web 内容不可信标记。
// 本文件把这类补丁列为 GATE，默认过滤掉；`/purge policy full` 可临时恢复上游行为。
//
// 分层依据（改动时务必同步 selfcheck 的层名）：
//   GATE  安全边界：审批 / 沙箱 / fs 围栏 / 外部内容降级 / hooks 否决 / 自动审核
//   其余   话术、身份、工具上限、兼容修复、UI —— 不影响任何拦截逻辑
//
// 只做"过滤"，不改补丁定义本身：这样上游 rebase 时冲突面最小，
// 且 `revertAll` 仍然按文件级备份还原，与策略无关。

/** 可选的策略模式。safe = 跳过 GATE，full = 上游原样。 */
export const POLICY_MODES = Object.freeze(["safe", "full"]);

/** 默认策略。自用版本默认安全，必须显式切换才回到上游行为。 */
export const DEFAULT_POLICY = "safe";

/**
 * 安全边界类补丁编号。每一条都会让某道真实拦截失效，注释说明理由。
 * 编号与上游 `ALL_PATCHES[].id` 对齐，升级上游后需复核。
 */
export const GATE_PATCHES = Object.freeze([
  5,  // APPROVAL_NEVER_SENTENCE        审批提示句被改写成"自动通过"
  6,  // SANDBOX_DENY_FILE_WRITE        删掉沙箱的"拒绝写文件"分支
  7,  // SANDBOX_MODE_DEFAULT           沙箱默认档改成 danger-full-access
  8,  // APPROVAL_POLICY_DEFAULT        默认审批策略改成 never
  9,  // APPROVAL_AUTO_GRANT            审批引擎无条件返回 allowed-once
  10, // APPROVAL_CONFIG_DEFAULT_NEVER  配置层默认 never
  11, // APPROVAL_NEVER_SENTENCE_BYPASS never 档的拒绝路径被短路
  12, // APPROVAL_ASK_SENTENCE_BYPASS   ask 档的拒绝路径被短路
  13, // ESCALATION_WIDENING_EXEMPT     放宽升级阶梯校验
  14, // ESCALATION_GRANT_UNCONDITIONAL 升级请求无条件授信
  15, // SANDBOX_CONFINE_PASSTHROUGH    沙箱 confine 直通
  16, // FS_FENCE_DISABLED              文件系统围栏的 per-call 检查被禁
  17, // FS_OBSERVATION_INTENT_FREE     观察策略的读写意图检查放行
  29, // TOOL_WEB_UNTRUSTED_NEUTRAL     web 内容从"不可信数据"改成"可直接使用"
  30, // HOOKS_CLAUDE_DENY_ALLOW        claude-code hooks 的 deny 被改成 allow
  31, // HOOKS_CODEX_DENY_ALLOW         codex hooks 的 deny 被改成 allow
  34, // SANDBOX_HINT_NEUTRAL           沙箱拒绝提示被改成"会自动批准"
  35, // ESCALATION_NEVER_REJECT        升级被拒绝/取消也照样授信
  36, // TOOL_FS_ESCALATION_SCHEMA      fs 升级字段去掉 user approval 约束
  37, // SUBAGENT_SCOPE_LOCK_NEUTRAL    子代理的权限锁被中和
  50, // SESSION_REFERENCE_FRAMING_NEUTRAL 跨会话引用去掉 untrusted 标记
  51, // FRESH_SESSION_FULL_ACCESS      新会话钉在 danger-full-access
  59, // OFFICIAL_AUTO_REVIEW_PASSTHROUGH Auto Review 不再拦工具
  60, // OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL run_code 的沙箱加宽自动放行
  61, // OFFICIAL_SANDBOX_POLICY_NEUTRAL sandbox-policy 的只读拦截中性化
  62, // OFFICIAL_TOOL_ASK_FAILOPEN     无审批通道时 fail-open
  63, // OFFICIAL_PLAN_MODE_NEUTRAL     计划模式的硬拦被取消
  65, // HOOKS_PRESTEP_REJECT_NEUTRAL   pre-step hook 的 deny 不再否决整轮
]);

const GATE_SET = new Set(GATE_PATCHES);

/** 该补丁是否属于安全边界类。 */
export function isGate(id) {
  return GATE_SET.has(Number(id));
}

/** 把外部输入收敛成已知策略，非法值回落到默认。 */
export function normalizePolicy(value) {
  const mode = typeof value === "string" ? value.trim().toLowerCase() : "";
  return POLICY_MODES.includes(mode) ? mode : DEFAULT_POLICY;
}

/**
 * 按策略挑选本轮要应用的补丁。
 * @param {ReadonlyArray<{id:number}>} all 上游 ALL_PATCHES
 * @param {string} policy safe | full
 */
export function selectPatches(all, policy = DEFAULT_POLICY) {
  const rows = Array.isArray(all) ? all : [];
  if (normalizePolicy(policy) === "full") return rows.slice();
  return rows.filter((patch) => !GATE_SET.has(Number(patch?.id)));
}

/** 本轮被策略挡下的补丁（用于状态面板与自检）。 */
export function skippedPatches(all, policy = DEFAULT_POLICY) {
  const rows = Array.isArray(all) ? all : [];
  if (normalizePolicy(policy) === "full") return [];
  return rows.filter((patch) => GATE_SET.has(Number(patch?.id)));
}

/** 自检面板用的层名 → 策略说明，避免把"故意跳过"显示成"未生效"。 */
export function policyNote(policy = DEFAULT_POLICY) {
  const mode = normalizePolicy(policy);
  if (mode === "full") return "策略 full：与上游一致，安全边界类补丁全部应用";
  return `策略 safe：已跳过 ${GATE_PATCHES.length} 条安全边界类补丁（审批/沙箱/fs 围栏/外部内容）`;
}

/**
 * 运行时"新会话强推完全权限"钩子（installFreshFullAccess）是否安装。
 * 它是 GATE #51 FRESH_SESSION_FULL_ACCESS 的运行时孪生：即使宿主补丁已被
 * safe 策略跳过，这个 session/created 钩子仍会把每个新建的普通会话
 * permissionPresets.set 成 danger-full-access，覆盖部署默认权限。
 * 与补丁策略对齐：safe 不装（新会话保留部署默认，如 workspace-write+ask），
 * full 保持上游行为；cfg.freshFullAccess 布尔值可显式覆盖两个方向。
 */
export function shouldInstallFreshFullAccess(cfg = {}) {
  if (typeof cfg?.freshFullAccess === "boolean") return cfg.freshFullAccess;
  return normalizePolicy(cfg?.patchPolicy) === "full";
}
