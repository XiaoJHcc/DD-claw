/**
 * 变更记录 → 面板用户的读法（`GET /api/undo/history` 的结构化字段）。
 *
 * 为什么是后端：同一条记录要喂两个前端（面板 + agent 回话），把「这条变更是什么」的判断分散到
 * 前端就会出现两份中文口径（改了一个忘另一个）。故**后端是唯一信源**：
 *   `title`   中文操作名（工具名 → 文案，未知工具回退原名）
 *   `detail`  逐行说明（`label` + `action` + `fields`），行来自 `RowImage` 的差分，不是另算一遍
 *   `undoNote` 撤销后的注意事项（`refill` = 该行是 LLM key 隐私例外，撤销 = 清空、需重填）
 *
 * 三条口径纪律：
 * - `undoNote` 的 refill 判定与 `core/undo.ts` 的隐私例外**同源**（`isLlmKeySetting`），别处不再写
 *   第二份 `llm_key:` 前缀判断。
 * - `fields` 的列集合与快照差分**同源**（`DEFAULT_IGNORE_COLUMNS`）：轮询回写列（游标/心跳/头像/
 *   平台昵称/updated_at）既不算差分也不列进说明，否则「保存主播别名」会顺带说“改了更新时间”。
 *   纯配置表（categories / push_rules / …）的 `updated_at` 不在忽略表、确实每次写都变，
 *   但对用户是噪音，在 `undoChangeDetail` 的 fields 生成处统一滤掉（差分/比对语义不受影响）。
 * - 翻译不了的键/列/工具**回退原名**，绝不丢信息（新增配置面时先能读，再补文案）。
 *
 * 契约（与 webui/js/undo.js 钉死）：detail 每项形如
 * `{ label: '分类「歌回」', action: 'created'|'deleted'|'updated', fields: ['启用'] }`；
 * `fields` 只在 `action='updated'` 时有列名（其余恒为 `[]`，键始终存在，前端不必判 undefined）。
 */
import {
  DEFAULT_IGNORE_COLUMNS, changeTables, isLlmKeySetting,
  type ChangeRecord, type RowImage, type Row,
} from '../core/undo.js';

/** 工具名没有（或认不出）时的标题：宁可说不知道，也不留空 */
export const UNKNOWN_TOOL_TITLE = '未知操作';

/**
 * 注册表工具名 → 中文操作名（webui 那份映射搬到这里，后端成为唯一信源）。
 * 新增写工具时补一行；漏了不会坏（回退工具原名），但面板上会出现英文名。
 */
const TOOL_TITLES: Record<string, string> = {
  // 只读查询（Agent 视图的工具行也用这张表——工具名 → 中文名就这一个信源）
  get_status: '查询当前状态',
  get_live_now: '查看在播列表',
  get_schedule: '查询时间表',
  list_streamers: '列出主播',
  search_streamers: '搜索主播',
  list_push_rules: '列出推送规则',
  list_categories: '列出分类',
  list_channels: '列出推送渠道',
  search_posts: '搜索图文帖',
  list_x_accounts: '列出 X 账号',
  list_weibo_accounts: '列出微博账号',
  list_bili_accounts: '列出 B站动态账号',
  list_post_rules: '列出图文规则',
  list_llm_providers: '列出 LLM 供应商',
  get_x_config: '查看 X 连接设置',
  list_group_channels: '列出群渠道',
  // 开关与运行时参数
  set_push_enabled: '开关推送',
  set_llm_enabled: '开关 LLM',
  set_listen: '监听开关',
  update_runtime_config: '修改运行时参数',
  set_llm_key: '设置 LLM 密钥',
  // 主播与三张图文账号名单
  watch_streamer: '加入监听',
  unwatch_streamer: '取消监听',
  set_streamer: '修改主播设置',
  upsert_x_account: '保存 X 账号',
  delete_x_account: '删除 X 账号',
  upsert_weibo_account: '保存微博账号',
  delete_weibo_account: '删除微博账号',
  upsert_bili_account: '保存 B站动态账号',
  delete_bili_account: '删除 B站动态账号',
  // 分类 / 推送规则 / 渠道 / 图文规则
  upsert_category: '保存分类',
  delete_category: '删除分类',
  upsert_push_rule: '保存推送规则',
  delete_push_rule: '删除推送规则',
  upsert_channel: '保存推送渠道',
  delete_channel: '删除推送渠道',
  upsert_post_rule: '保存图文规则',
  delete_post_rule: '删除图文规则',
  // 拖拽排序（四个 reorder_* 是拖拽落库的唯一入口）
  reorder_channels: '调整渠道顺序',
  reorder_categories: '调整分类顺序',
  reorder_push_rules: '调整推送规则顺序',
  reorder_post_rules: '调整图文规则顺序',
  // LLM 供应商与 X 连接
  upsert_llm_provider: '保存 LLM 供应商',
  delete_llm_provider: '删除 LLM 供应商',
  reorder_llm_providers: '调整供应商顺序',
  update_x_config: '修改 X 连接设置',
  // agent 会话设置（两个开关都不进 agent 工具面，只由主人从面板改）
  set_chat_mode: '设置写模式',
  set_chat_provider: '选择 Agent 模型',
  // 群自助规则（gateway 令牌；名字里带「群自助」以免与面板规则混淆）
  add_group_push_rule: '群自助加推送规则',
  remove_group_push_rule: '群自助删推送规则',
  // 撤销执行器（track:false，正常不会出现在历史里；列全只是万一落到就能读）
  undo_last_change: '撤销变更',
  // 测试类（有对外副作用、不入撤销；列全只是万一落进历史也能读）
  test_push: '测试推送',
  test_llm_provider: '测试 LLM 供应商',
  test_x_connection: '测试 X 连接',
};

/** 工具名 → 中文操作名；未知回退原名，没有工具名 = `未知操作` */
export function undoToolTitle(tool: string | null | undefined): string {
  if (tool === null || tool === undefined || tool === '') return UNKNOWN_TOOL_TITLE;
  return TOOL_TITLES[tool] ?? tool;
}

/**
 * settings 键 → 中文设置项名。键名单以代码为准（`runtime-config.ts` 的 NUM_SPECS / BOOL_SPECS、
 * `x-config.ts`、`listen.ts`、`qqbot/settings.ts`、`napcat.ts`、`providers.ts`、`system-prompt.ts`）；
 * 精确名单之外按前缀兜底，再之外回退键原名。
 */
const SETTING_NAMES: Record<string, string> = {
  // 总开关
  push_enabled: '推送总开关',
  llm_enabled: 'LLM 总开关',
  llm_providers: 'LLM 供应商名单',
  chat_write_mode: 'Agent 写模式',
  chat_provider: 'Agent 模型选择',
  mcp_tokens: 'MCP 令牌',
  // 监听开关（auto / 手动开 / 手动关；见 core/listen.ts）
  listen_dynamic: 'B站动态监听开关',
  listen_weibo: '微博监听开关',
  listen_twitter: 'X 监听开关',
  // 运行时参数（core/runtime-config.ts NUM_SPECS / BOOL_SPECS）
  poll_interval_sec: '直播轮询间隔',
  poll_jitter_sec: '轮询抖动',
  health_alert_after_failures: '连续失败告警阈值',
  follows_sync_interval_sec: '关注列表同步间隔',
  dynamic_interval_sec: '动态轮询间隔',
  weibo_interval_sec: '微博轮询间隔',
  llm_request_timeout_ms: 'LLM 请求超时',
  llm_circuit_threshold: 'LLM 熔断阈值',
  llm_circuit_cooldown_ms: 'LLM 熔断冷却',
  keyframe_interval_sec: '关键帧缓存间隔',
  keyframe_enabled: '关键帧缓存',
  notify_on_first_run: '启动时已在播也推送',
  notify_on_new_subscription: '新增订阅在播即推送',
  backlog_push_enabled: '补推未运行期间的图文',
  backlog_max_age_hours: '补推时间限制（小时）',
  backlog_max_per_account: '补推账号条数限制',
  // 推送文案（core/push.ts）
  default_template: '默认推送词',
  // X / 推特（core/x-config.ts）
  x_proxy_url: 'X 代理地址',
  x_nitter_instances: 'X Nitter 实例',
  x_interval_sec: 'X 抓取间隔',
  x_fallback_html: 'X 免登录回退',
  // NapCat 托管（notify/napcat.ts）
  napcat_enabled: 'NapCat 托管开关',
  napcat_autorestart: 'NapCat 失活自动拉起',
  napcat_dir: 'NapCat 安装目录',
  napcat_uin: 'NapCat QQ 号',
  napcat_alert_qq: 'NapCat 告警 QQ',
  // QQ 机器人（qqbot/settings.ts）
  qqbot_enabled: 'QQ 机器人开关',
  qq_channel_map: 'QQ 渠道映射',
  qqbot_trigger_prefix: 'QQ 唤起前缀',
};

/** settings 行 → 中文设置项名（键名 + 前缀兜底 + 原名回退；`llm_key:*` 用同一份隐私判据） */
function settingLabel(key: unknown): string {
  const k = typeof key === 'string' ? key : String(key ?? '');
  if (isLlmKeySetting(k)) return `LLM 密钥（${k.slice('llm_key:'.length)}）`;
  const exact = SETTING_NAMES[k];
  if (exact !== undefined) return exact;
  if (k.startsWith('napcat_')) return `NapCat 设置（${k}）`;
  if (k.startsWith('qqbot_')) return `QQ 机器人设置（${k}）`;
  return k;
}

/** 表名 → 行标签前缀（表里没有的行说明这里的映射漏了，回退表名本身） */
const TABLE_LABELS: Record<string, string> = {
  settings: '设置项',
  categories: '分类',
  push_rules: '推送规则',
  post_rules: '图文规则',
  push_channels: '推送渠道',
  streamers: '主播',
  x_accounts: 'X 账号',
  weibo_accounts: '微博账号',
  bili_accounts: 'B站动态账号',
};

/** 每表用来做行标签的列（先后顺序 = 优先级；都没有则退回主键） */
const LABEL_COLUMNS: Record<string, readonly string[]> = {
  categories: ['name'],
  push_rules: ['name'],
  post_rules: ['name'],
  push_channels: ['name'],
  // 主播：uname 是平台事实，alias（简称）只在没有 uname 时兜底——与面板展示口径一致
  streamers: ['uname', 'alias'],
  x_accounts: ['screen_name'],
  weibo_accounts: ['nickname', 'display_name'],
  bili_accounts: ['uname', 'display_name'],
};

function text(row: Row | null, column: string): string {
  const v = row?.[column];
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v);
}

/** 主键值（拿不到名字时的兜底，宁可给 `#3` 也不给空标签） */
function pkText(img: RowImage): string {
  const values = Object.values(img.pk).filter((v) => v !== null && v !== undefined);
  return values.length > 0 ? `#${values.map(String).join('/')}` : '（未知主键）';
}

/** 单行 → 人读得懂的标签：settings = 设置项中文名；其余 = `分类「歌回」` 式 */
export function undoRowLabel(img: RowImage): string {
  if (img.table === 'settings') return settingLabel(img.pk.key);
  const row = img.after ?? img.before;
  const prefix = TABLE_LABELS[img.table] ?? img.table;
  for (const col of LABEL_COLUMNS[img.table] ?? []) {
    const name = text(row, col);
    if (name !== '') return `${prefix}「${name}」`;
  }
  return `${prefix}「${pkText(img)}」`;
}

/**
 * 列名 → 中文（按表；未列出的列回退原列名）。
 * 只覆盖又出现在 `fields` 里的列（= 非忽略列），忽略列进不了这里。
 */
const COLUMN_NAMES: Record<string, Record<string, string>> = {
  settings: { key: '键名', value: '值' },
  categories: {
    name: '名称', llm_prompt: 'LLM 提示词', keywords: '关键词', areas: '分区',
    cond_mode: '条件关系', enabled: '启用', sort: '排序',
  },
  push_rules: {
    name: '名称', category_id: '分类', uids: '生效主播', channels: '推送渠道',
    message_template: '推送词', enabled: '启用', sort: '排序', created_by: '创建来源',
  },
  push_channels: {
    name: '名称', notifier: '通道类型', target_type: '目标类型', target_id: '目标 ID',
    enabled: '启用', sort: '排序',
  },
  post_rules: {
    name: '名称', filters: '筛选条件', channels: '推送渠道', message_template: '推送词',
    llm_judge: 'LLM 判定', judge_prompt: '判定标准', llm_translate: '翻译',
    enabled: '启用', sort: '排序', platform: '平台（旧字段）', account_ids: '账号（旧字段）',
  },
  streamers: {
    uid: 'UID', uname: '昵称', alias: '简称', room_id: '直播间', weibo_uid: '微博 UID',
    weibo_nick: '微博昵称', watch: '监听', analyze: '分析', notify: '推送',
    profile_note: '画像', source: '来源',
  },
  x_accounts: {
    screen_name: '账号', nickname: '昵称', display_name: '显示名', bili_uid: '关联主播',
    enabled: '启用', rule_ids: '选用图文规则',
  },
  weibo_accounts: {
    uid: '微博 UID', nickname: '昵称', display_name: '显示名', bili_uid: '关联主播',
    enabled: '启用', rule_ids: '选用图文规则',
  },
  bili_accounts: {
    uid: 'UID', uname: '昵称', display_name: '显示名', enabled: '启用', rule_ids: '选用图文规则',
  },
};

/** 所有快照表共用的时间戳列（几张纯配置表的 updated_at 每次写都会变，属「真的变了」但不值得单独抄每张表） */
const COMMON_COLUMN_NAMES: Record<string, string> = {
  created_at: '创建时间',
  updated_at: '更新时间',
};

function columnLabel(table: string, column: string): string {
  return COLUMN_NAMES[table]?.[column] ?? COMMON_COLUMN_NAMES[column] ?? column;
}

function norm(v: unknown): unknown {
  return v === undefined ? null : v;
}

/**
 * 变的非忽略列（与快照差分的列集合同源：`DEFAULT_IGNORE_COLUMNS`）。
 * 隐私行（`redacted`，值不落库）没有前像/后像可比——它的变化列就是 `settings.value` 本身。
 */
function changedColumns(img: RowImage): string[] {
  if (img.redacted) return ['value'];
  const ignore = new Set(DEFAULT_IGNORE_COLUMNS[img.table] ?? []);
  const before = img.before ?? {};
  const after = img.after ?? {};
  const columns = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...columns].filter((c) => !ignore.has(c) && JSON.stringify(norm(before[c])) !== JSON.stringify(norm(after[c])));
}

export type UndoRowAction = 'created' | 'deleted' | 'updated';

export interface UndoDetailRow {
  label: string;
  action: UndoRowAction;
  /** 变化的非忽略列（中文）；只在 action='updated' 时非空 */
  fields: string[];
}

/** 行的动作：前像无 = 新建、后像无 = 删除、其余 = 修改（隐私行给后像，故恒为 updated 一类） */
export function undoRowAction(img: RowImage): UndoRowAction {
  if (!img.beforeExists) return 'created';
  if (!img.afterExists) return 'deleted';
  return 'updated';
}

export function undoChangeDetail(c: ChangeRecord): UndoDetailRow[] {
  return c.rows.map((img) => {
    const action = undoRowAction(img);
    return {
      label: undoRowLabel(img),
      action,
      // 键恒存在（前端不必判 undefined）；列名只对 updated 有意义，其余给空数组。
      // updated_at 每次写都变、对用户是噪音（「改了别名、更新时间」），在源头滤掉
      fields: action === 'updated'
        ? changedColumns(img).filter((col) => col !== 'updated_at').map((col) => columnLabel(img.table, col))
        : [],
    };
  });
}

/**
 * 撤销这条记录时要在界面上说的注意事项：`refill` = 该记录涉及 LLM key 隐私例外
 * （值本来就没落库），撤销动作 = 清空该行、需要主人重新填写。
 * 判定与 `core/undo.ts` 同源（工具名 + `isLlmKeySetting`），不另造口径。
 */
export function undoChangeNote(c: ChangeRecord): 'refill' | null {
  if (c.tool === 'set_llm_key') return 'refill';
  const keyRow = c.rows.some((r) => r.table === 'settings' && isLlmKeySetting(r.pk.key));
  return keyRow ? 'refill' : null;
}

/**
 * 变更记录 → 历史端点形状。老字段（id/tool/entry/actor/scope/at/undone/tables/rows）**逐字不动**
 * （前端与 demo mock 已按它写），结构化三字段为增量：`title` / `detail` / `undoNote`。
 * `at` 秒级（库里毫秒），`tables` 去重，`rows` = 受影响行数。
 */
export function undoChangeInfo(c: ChangeRecord): Record<string, unknown> {
  return {
    id: c.id,
    tool: c.tool ?? null,
    entry: c.entry,
    actor: c.actor,
    scope: c.scope,
    at: Math.floor(c.at / 1000),
    undone: c.undoneAt !== null,
    tables: changeTables(c),
    rows: c.rows.length,
    title: undoToolTitle(c.tool),
    detail: undoChangeDetail(c),
    undoNote: undoChangeNote(c),
  };
}