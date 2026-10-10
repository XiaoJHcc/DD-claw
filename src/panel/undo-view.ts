/**
 * 变更记录 → 面板用户的读法（`GET /api/undo/history` 的结构化字段）。
 *
 * 为什么是后端：同一条记录要喂两个前端（面板 + agent 回话），把「这条变更是什么」的判断分散到
 * 前端就会出现两份中文口径（改了一个忘另一个）。故**后端是唯一信源**：
 *   `title`    中文操作名（工具名 → 文案，未知工具回退原名；agent 工具行也复用这份）
 *   `headline` 一句话操作描述（**值感知**：布尔单列变化直接变动词「停用了推送规则「杂谈-开播」」，
 *              级联写取结构主体行「删除了分类「杂谈」」，多行并列回退「工具名（N 项变更）」）
 *   `detail`   逐行说明（`label` + `action` + `changes`），行来自 `RowImage` 的差分，不是另算一遍；
 *              `changes` 带**格式化后的旧值/新值**（布尔 → 开/关、JSON 数组 → 顿号连接、数值
 *              settings 键 → 带单位、长文本截断），回答「从什么改成了什么」，而非「改了哪些列」
 *   `undoNote` 撤销后的注意事项（`refill` = 该行是 LLM key 隐私例外，撤销 = 清空、需重填）
 *
 * 三条口径纪律：
 * - `undoNote` 的 refill 判定与 `core/undo.ts` 的隐私例外**同源**（`isLlmKeySetting`），别处不再写
 *   第二份 `llm_key:` 前缀判断。
 * - `changes` 的列集合与快照差分**同源**（`DEFAULT_IGNORE_COLUMNS`）：轮询回写列（游标/心跳/头像/
 *   平台昵称/updated_at）既不算差分也不列进说明，否则「保存主播别名」会顺带说“改了更新时间”。
 *   纯配置表（categories / push_rules / …）的 `updated_at` 不在忽略表、确实每次写都变，
 *   但对用户是噪音，在 `undoChangeDetail` 的 changes 生成处统一滤掉（差分/比对语义不受影响）。
 * - 翻译不了的键/列/工具**回退原名**，绝不丢信息（新增配置面时先能读，再补文案）。
 *
 * 契约（与 webui/js/undo.js 钉死）：detail 每项形如
 * `{ label: '分类「歌回」', action: 'created'|'deleted'|'updated',
 *    changes: [{ field: '关键词', from: '唱、歌', to: '唱、歌、演唱会' }] }`；
 * `changes` 只在 `action='updated'` 时非空（其余恒为 `[]`，键始终存在，前端不必判 undefined）；
 * 布尔开关变化带 `bool: true`（from/to 恒为 开/关，供前端省略冗余字段名）；
 * 值不可示人的变化（LLM key、MCP 令牌）给 `{ field, redacted: true }`，无 from/to。
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
    cond_mode: '条件关系', enabled: '启用', sort: '位置',
  },
  push_rules: {
    name: '名称', category_id: '分类', uids: '生效主播', channels: '推送渠道',
    message_template: '推送词', enabled: '启用', sort: '位置', created_by: '创建来源',
  },
  push_channels: {
    name: '名称', notifier: '通道类型', target_type: '目标类型', target_id: '目标 ID',
    enabled: '启用', sort: '位置',
  },
  post_rules: {
    name: '名称', filters: '筛选条件', channels: '推送渠道', message_template: '推送词',
    llm_judge: 'LLM 判定', judge_prompt: '判定标准', llm_translate: '翻译',
    enabled: '启用', sort: '位置', platform: '平台（旧字段）', account_ids: '账号（旧字段）',
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

export interface UndoFieldChange {
  /** 变化列的中文名（「位置」「启用」「关键词」…；settings kv 行 = 设置项中文名） */
  field: string;
  /** 格式化后的旧值 / 新值；redacted 时两者都不存在 */
  from?: string;
  to?: string;
  /** 值不可示人（LLM key、MCP 令牌）：前端只显示「已更新（值不落库）」 */
  redacted?: boolean;
  /** 布尔开关变化（from/to 恒为 开/关）：前端据此省略冗余字段名，单行布尔变化甚至整行省略 */
  bool?: boolean;
}

export interface UndoDetailRow {
  label: string;
  action: UndoRowAction;
  /** 带值的变化清单（中文列名 + 格式化旧值/新值）；只在 action='updated' 时非空 */
  changes: UndoFieldChange[];
}

/** 行的动作：前像无 = 新建、后像无 = 删除、其余 = 修改（隐私行给后像，故恒为 updated 一类） */
export function undoRowAction(img: RowImage): UndoRowAction {
  if (!img.beforeExists) return 'created';
  if (!img.afterExists) return 'deleted';
  return 'updated';
}

// ---- 值格式化：把库里的原始值翻成用户语言 ----

/** 整数 0/1 布尔列（按表；忽略列进不了这里） */
const BOOL_COLUMNS: Record<string, readonly string[]> = {
  categories: ['enabled'],
  push_rules: ['enabled'],
  push_channels: ['enabled'],
  post_rules: ['enabled', 'llm_judge', 'llm_translate'],
  streamers: ['watch', 'analyze', 'notify'],
  x_accounts: ['enabled'],
  weibo_accounts: ['enabled'],
  bili_accounts: ['enabled'],
};

/** 值为 '1'/'0' 的布尔 settings 键（listen_* 按前缀兜底；与 listen.ts / runtime-config.ts 的存储口径一致） */
const BOOL_SETTING_KEYS: readonly string[] = [
  'push_enabled', 'llm_enabled', 'napcat_enabled', 'napcat_autorestart', 'qqbot_enabled',
  'x_fallback_html', 'keyframe_enabled', 'notify_on_first_run', 'notify_on_new_subscription',
  'backlog_push_enabled',
];

/** JSON 数组列 → 顿号连接（存的是 JSON 文本；解析失败回退原文截断） */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  categories: ['keywords', 'areas'],
  push_rules: ['uids', 'channels'],
  post_rules: ['channels', 'filters'],
  x_accounts: ['rule_ids'],
  weibo_accounts: ['rule_ids'],
  bili_accounts: ['rule_ids'],
};

/** 数值型 settings 键 → 单位（NUM_SPECS 全量 + X 抓取间隔；label 里有单位的不再重复） */
const SETTING_UNITS: Record<string, string> = {
  poll_interval_sec: '秒', poll_jitter_sec: '秒', follows_sync_interval_sec: '秒',
  dynamic_interval_sec: '秒', weibo_interval_sec: '秒', keyframe_interval_sec: '秒',
  x_interval_sec: '秒', llm_request_timeout_ms: '毫秒', llm_circuit_cooldown_ms: '毫秒',
  health_alert_after_failures: '次', llm_circuit_threshold: '次', backlog_max_age_hours: '小时',
};

/** 值不可示人的 settings 键（LLM key 在 undo.ts 层已 redact；这里兜住其余敏感配置） */
const SECRET_SETTING_KEYS: readonly string[] = ['mcp_tokens'];

/** 小枚举列 → 中文（`表.列` 为键） */
const ENUM_VALUES: Record<string, Record<string, string>> = {
  'categories.cond_mode': { and: '且', or: '或' },
  'push_channels.notifier': { onebot: 'NapCat', toast: '本机 Toast' },
  'push_channels.target_type': { group: 'QQ 群', private: '私聊' },
};

/** 长文本统一截断长度（推送词 / 提示词 / 画像这类自由文本） */
const VALUE_CAP = 30;

function truncate(s: string): string {
  return s.length > VALUE_CAP ? s.slice(0, VALUE_CAP) + '…' : s;
}

/** 该 表+列 / settings 键 是否 0/1 布尔（formatValue 与 changes 的 bool 标记同源） */
function isBoolCell(table: string, column: string, settingKey?: string): boolean {
  if (BOOL_COLUMNS[table]?.includes(column)) return true;
  return table === 'settings' && settingKey !== undefined &&
    (BOOL_SETTING_KEYS.includes(settingKey) || settingKey.startsWith('listen_'));
}

/** 单值 → 人读形态；返回 null = 值不可示人（调用方给 redacted 变化项） */
function formatValue(table: string, column: string, v: unknown, settingKey?: string): string | null {
  if (settingKey !== undefined && SECRET_SETTING_KEYS.includes(settingKey)) return null;
  if (v === null || v === undefined || v === '') return '（空）';
  if (isBoolCell(table, column, settingKey)) {
    return v === 1 || v === '1' || v === true ? '开' : v === 0 || v === '0' || v === false ? '关' : String(v);
  }
  const enumMap = ENUM_VALUES[`${table}.${column}`];
  if (enumMap) return enumMap[String(v)] ?? String(v);
  if (column === 'sort') return `第 ${String(v)} 位`;
  if (table === 'settings' && settingKey !== undefined && SETTING_UNITS[settingKey] !== undefined) {
    const n = Number(v);
    const unit = SETTING_UNITS[settingKey];
    // 毫秒值能整除时按秒读（60000 毫秒 → 60 秒），人不按毫秒想问题
    if (unit === '毫秒' && Number.isFinite(n) && n % 1000 === 0) return `${n / 1000} 秒`;
    return `${String(v)} ${unit}`;
  }
  if (JSON_COLUMNS[table]?.includes(column) ?? false) {
    try {
      const parsed: unknown = JSON.parse(String(v));
      if (Array.isArray(parsed)) return truncate(parsed.map((x) => String(x)).join('、')) || '（空）';
      return truncate(JSON.stringify(parsed));
    } catch { return truncate(String(v)); }
  }
  // settings 的 JSON 值（llm_providers / x_nitter_instances / qq_channel_map 等）尝试展开，失败回原文
  if (table === 'settings') {
    const s = String(v);
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(s);
        if (Array.isArray(parsed)) return truncate(parsed.map((x) => String(x)).join('、')) || '（空）';
        return truncate(JSON.stringify(parsed));
      } catch { /* 落下面原文 */ }
    }
    return truncate(s);
  }
  return truncate(String(v));
}

/** 一行 updated 的带值变化清单（updated_at 噪音在此滤掉；redacted 行只报列名不给值） */
function rowChanges(img: RowImage): UndoFieldChange[] {
  if (undoRowAction(img) !== 'updated') return [];
  const settingKey = img.table === 'settings' ? String(img.pk.key ?? '') : undefined;
  return changedColumns(img)
    .filter((col) => col !== 'updated_at')
    .map((col) => {
      // settings 是 kv 面：列名恒为「值」等于没说——字段名直接用设置项中文名（「推送总开关：开 → 关」）
      const field = img.table === 'settings' && settingKey !== undefined
        ? settingLabel(settingKey)
        : columnLabel(img.table, col);
      if (img.redacted) return { field, redacted: true };
      const from = formatValue(img.table, col, img.before?.[col], settingKey);
      const to = formatValue(img.table, col, img.after?.[col], settingKey);
      if (from === null || to === null) return { field, redacted: true };
      const bool = isBoolCell(img.table, col, settingKey);
      return bool ? { field, from, to, bool: true } : { field, from, to };
    });
}

export function undoChangeDetail(c: ChangeRecord): UndoDetailRow[] {
  return c.rows.map((img) => ({
    label: undoRowLabel(img),
    action: undoRowAction(img),
    changes: rowChanges(img),
  }));
}

// ---- headline：一句话操作描述（历史列表的主标题，值感知） ----

/** 行标签的对象部分（「老E」式，供动词组句）；无书名号则回整个标签（settings 名本就不带） */
function objectPart(label: string): string {
  const i = label.indexOf('「');
  return i >= 0 ? label.slice(i) : label;
}

/** 布尔单列变化 → 动词句；不是布尔单列变化返回 null（调用方回退「修改了…」）。
 *  settings 行只看 value 列（key 是主键不是「变化」），故 created（首次手动关开关）也能组句 */
function boolVerbHeadline(img: RowImage): string | null {
  const cols = changedColumns(img)
    .filter((c) => c !== 'updated_at' && (img.table !== 'settings' || c === 'value'));
  if (cols.length !== 1) return null;
  const col = cols[0]!;
  const v = img.after?.[col];
  const on = v === 1 || v === '1' || v === true;
  if (!on && v !== 0 && v !== '0' && v !== false) return null;
  const label = undoRowLabel(img);
  if (img.table === 'settings') {
    const key = String(img.pk.key ?? '');
    const isBoolKey = BOOL_SETTING_KEYS.includes(key) || key.startsWith('listen_');
    return isBoolKey ? `${on ? '开启了' : '关闭了'}${label}` : null;
  }
  if (col === 'enabled' && (BOOL_COLUMNS[img.table]?.includes('enabled') ?? false)) {
    return `${on ? '启用了' : '停用了'}${label}`;
  }
  if (img.table === 'streamers') {
    if (col === 'watch') return `${on ? '开始监听' : '停止监听'}${objectPart(label)}`;
    if (col === 'analyze') return `${on ? '开启了' : '关闭了'}${objectPart(label)}的 LLM 分析`;
    if (col === 'notify') return `${on ? '开启了' : '关闭了'}${objectPart(label)}的推送`;
  }
  if (img.table === 'post_rules' && col === 'llm_judge') return `${on ? '开启了' : '关闭了'}${label}的 LLM 判定`;
  if (img.table === 'post_rules' && col === 'llm_translate') return `${on ? '开启了' : '关闭了'}${label}的翻译`;
  return null;
}

/**
 * 一条记录的一句话描述。主行挑选：恰一行的结构性变化（created/deleted）是主体——
 * 级联写（删分类顺带停用 N 条规则）里它才是人做的事，其余行进 detail；
 * 全 updated 多行（reorder / 批量 / 多键参数）没有主体，回退「工具名（N 项变更）」。
 */
export function undoChangeHeadline(c: ChangeRecord): string {
  const structural = c.rows.filter((r) => undoRowAction(r) !== 'updated');
  const primary = structural.length === 1 ? structural[0]! : c.rows.length === 1 ? c.rows[0]! : null;
  if (primary === null) return `${undoToolTitle(c.tool)}（${c.rows.length} 项变更）`;
  const label = undoRowLabel(primary);
  const action = undoRowAction(primary);
  // LLM key 行（created/updated 都可能，redacted 无值可比）与 settings 布尔键
  // （首次手动关开关 = created 行）都能给值感知句式，优先于按动作组句
  if (primary.table === 'settings' && isLlmKeySetting(primary.pk.key)) {
    return `设置了 ${String(primary.pk.key).slice('llm_key:'.length)} 的 LLM 密钥`;
  }
  if (primary.table === 'settings') {
    const boolHeadline = boolVerbHeadline(primary);
    if (boolHeadline !== null) return boolHeadline;
  }
  if (action === 'created') return `新增了${label}`;
  if (action === 'deleted') return `删除了${label}`;
  const boolHeadline = boolVerbHeadline(primary);
  if (boolHeadline !== null) return boolHeadline;
  return `修改了${label}`;
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
 * （前端与 demo mock 已按它写），结构化字段为增量：`title` / `headline` / `detail` / `undoNote` /
 * `undoneAt`（撤销时刻，秒；未撤销 = null，前端据此显示「已于 HH:MM 撤销」）。
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
    undoneAt: c.undoneAt === null ? null : Math.floor(c.undoneAt / 1000),
    tables: changeTables(c),
    rows: c.rows.length,
    title: undoToolTitle(c.tool),
    headline: undoChangeHeadline(c),
    detail: undoChangeDetail(c),
    undoNote: undoChangeNote(c),
  };
}