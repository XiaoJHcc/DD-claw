/**
 * MCP 工具注册表（能力层）：面板 REST 之外的第二适配面，handler 全部复用面板同款
 * Db 方法 / http-util 校验函数 / deps 热生效回调——写路径与面板语义完全一致。
 *
 * 权限模型（详见 auth.ts 头注释）：工具参数不可信（LLM 生成，可被 prompt injection 伪造），
 * 可信的只有连接级 token 角色。因此 admin 工具在 gateway 连接上根本不注册（tools/list
 * 不可见），而不是注册后拒绝。gateway 唯一可写的是「群/私聊推送规则自助」，服务端强制：
 * **渠道只来自调用域 `ctx.scope.channelId`（令牌绑定）——身份字段永不进工具 schema**
 * （LLM 填的渠道声明会被 zod 剥离，见 run-tool.ts），未绑渠道一律 403 不回落；
 * 该渠道必须是已启用的 onebot group/private；读侧按 scope 服务端裁剪（不把别渠道的规则喂进上下文）；
 * 主播必须在监听名单、规则打 createdBy='mcp'、删除先校验渠道归属、多渠道规则走 copy-on-write 拆分、
 * 单渠道 ≤ 20 条、写操作按渠道限流。契约见 docs/mcp.md「gateway 写/读的服务端强制」。
 */
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PanelDeps } from '../panel/server.js';
import {
  HttpError, checkCategoryConditions, checkChannelShape,
  checkRuleRefs, parseBiliAccountPatch,
  parseCategoryPatch, parseChannelPatch,
  parseNewBiliAccount, parseNewCategory, parseNewChannel, parseNewRule, parseNewWeiboAccount,
  parseNewXAccount,
  parseRulePatch, parseRuntimePatch, parseStreamerPatch, parseWeiboAccountPatch,
  parseXAccountPatch, parseXPatch, parseXTestRequest, syncStreamerWeiboLink, watchStreamer,
} from '../panel/http-util.js';
import { scheduleInfo } from '../panel/schedule.js';
import { runCategoryTest, sampleCategoryRecords } from '../panel/category-test.js';
import { SAMPLE_LIMIT_MAX } from '../core/db.js';
import { setPushEnabled, splitPushRuleChannel, type PushChannel } from '../core/push.js';
import { normalizeCsvText, splitCsvText } from '../core/csv.js';
import { setListen, listenReadyFor, listenSetting, type ListenFeature } from '../core/listen.js';
import { setChatWriteMode, type ChatWriteMode } from '../agent/system-prompt.js';
import { X_INTERVAL_MAX, X_INTERVAL_MIN } from '../core/x-config.js';
import { getRuntimeConfig, saveRuntimeConfig, NUM_SPECS, BOOL_SPECS } from '../core/runtime-config.js';
import { hasLlmProvider, isLlmEnabled, llmKeySetting, setChatProvider, setLlmEnabled } from '../analysis/providers.js';
import {
  dbDecisionKeysOf, decisionKeySetting, decisionNeedsAuth, isDecisionEnabled, setDecisionEnabled,
} from '../analysis/decision-providers.js';
import { decisionProviderSchema, llmProviderSchema } from '../config/schema.js';
import type { StreamerInput } from '../core/streamers.js';
import { mcpWriteLimiter, writeLimitBucket } from './rate-limit.js';
import { runToolTracked, scopeChannelId, undoScopeOf } from './run-tool.js';
import type { McpAuth } from './auth.js';

/** gateway 渠道自助：单渠道 MCP 规则上限 */
const MAX_MCP_RULES_PER_CHANNEL = 20;

type ToolRole = 'shared' | 'admin' | 'gateway';

export interface McpToolDef {
  name: string;
  description: string;
  /** zod raw shape（registerTool 的 inputSchema） */
  schema: Record<string, z.ZodTypeAny>;
  /** shared = 两角色可见；admin/gateway = 仅该角色可见 */
  role: ToolRole;
  /** 写操作：记审计日志 */
  write?: boolean;
  /**
   * 该写工具是否进快照栈（缺省进）。只有一个工具设 false：撤销执行器 `undo_last_change`——
   * 它的写是把已记录的前像写回去，入栈会把自己变成下一条可撤销记录（见 core/undo.ts）。
   */
  track?: false;
  handler: (deps: PanelDeps, args: Record<string, unknown>, ctx: McpAuth) => unknown | Promise<unknown>;
}

const uidSchema = z.string().regex(/^\d+$/, 'uid 必须是纯数字字符串');
const idSchema = z.number().int().positive();

/**
 * 精确条件（分类判定模式的原子条件）。`id` 只由调用方在**已有**条件上回传（试判 / 审计按它对齐）；
 * 新条件可以不给，后端补 randomUUID。形状是 strict：拼错字段名必须报错，不能被静默剥掉。
 */
const judgeConditionSchema = z.object({
  id: z.string().optional().describe('条件 id（已有条件必须原样回传；新条件可省略，后端生成）'),
  direction: z.enum(['pass', 'reject']).describe('pass=正向（任一成立即可支持）/ reject=负向（任一成立即否决）'),
  text: z.string().describe('条件原文（非空；模型按这一条独立判定）'),
  enabled: z.boolean().optional().describe('是否参与判定（缺省 true）；停用项照样保存'),
}).strict();

const judgeConditionsSchema = z.array(judgeConditionSchema).describe('精确条件列表，数组顺序即展示顺序');

/** 从 args 挑出「出现过」的键组成 body 对象（复用面板 parse* 校验函数） */
function pickBody(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of keys) if (k in args && args[k] !== undefined) o[k] = args[k];
  return o;
}

/** X 账号的关联主播必须存在于监听名单（与面板 checkXBiliUid 同一条校验） */
function checkXBiliUidForMcp(deps: PanelDeps, uid: string | null): void {
  if (uid && !deps.db.getStreamer(uid)) throw new HttpError(400, `关联主播不在监听名单: ${uid}`);
}

/** 微博账号的关联主播校验（与 checkXBiliUidForMcp 同一条纪律） */
function checkWeiboBiliUidForMcp(deps: PanelDeps, uid: string | null): void {
  if (uid && !deps.db.getStreamer(uid)) throw new HttpError(400, `关联主播不在监听名单: ${uid}`);
}

/** 排序类工具的公共校验：ids 必须是现有行的全排列（与面板 put*Order 同一口径、同一句文案） */
function checkFullPermutation(ids: number[], existing: number[], what: string): void {
  const set = new Set(existing);
  if (ids.length !== set.size || new Set(ids).size !== ids.length || ids.some((id) => !set.has(id))) {
    throw new HttpError(400, `ids 必须与现有${what}一一对应`);
  }
}

// ---- 调用域（scope）：渠道是 QQ 入口唯一可信的锚点，只由接入层/令牌解析后注入 ----
// 工具 schema 里没有任何渠道字段（见 run-tool.ts 头注释）：LLM 在参数里声明的渠道会被 zod 剥离，
// 能力层只认 ctx.scope.channelId。读 / 写 / 限流共用这一个锚点。

/**
 * 读侧裁剪用的调用域渠道：admin（面板 / Claude Code / 进程内 agent）无 scope = 不裁剪（全量，行为不变）；
 * gateway 未绑渠道 = **拒绝服务**（绝不回落默认渠道，也绝不回落「全部」——否则一句话就能读到别人的配置）。
 */
function scopeChannelForRead(ctx: McpAuth): number | undefined {
  const ch = scopeChannelId(ctx);
  if (ch !== undefined || ctx.role === 'admin') return ch;
  throw new HttpError(403, '本令牌未绑定渠道：推送规则自助只服务令牌绑定的渠道，请让主人给令牌绑定渠道');
}

/** gateway 自助工具的渠道（必给）：未绑定即拒；admin 走全量 CRUD，不该出现在这里 */
function requireScopeChannel(ctx: McpAuth): number {
  const ch = scopeChannelForRead(ctx);
  if (ch !== undefined) return ch;
  throw new HttpError(
    403,
    'admin 令牌没有渠道 scope：本工具只服务「令牌绑定的渠道」自助，'
    + '管理侧请用 upsert_push_rule / delete_push_rule（channels 参数显式给）',
  );
}

/** 自助可用的渠道：已启用的 onebot 群或私聊（私聊一视同仁，见 plan P2「渠道类型放开」） */
function isSelfServiceChannel(c: PushChannel): boolean {
  return c.notifier === 'onebot' && (c.targetType === 'group' || c.targetType === 'private') && c.enabled;
}

/** 调用域渠道行 + 自助资格（渠道被停用/删掉/换成 toast 时拒绝，绝不静默改到别处） */
function selfServiceChannel(deps: PanelDeps, channelId: number): PushChannel {
  const c = deps.db.listPushChannels().find((x) => x.id === channelId);
  if (!c || !isSelfServiceChannel(c)) {
    throw new HttpError(400, '本渠道不是已启用的 QQ 群/私聊渠道，不能自助配置推送规则（先 list_group_channels 看可选渠道）');
  }
  return c;
}

// ---- 共享只读工具 ----

const sharedTools: McpToolDef[] = [
  {
    name: 'get_status',
    description: '运行状态：平台登录态（B站/微博）、在播数、监听数、已装配通知通道',
    schema: {},
    role: 'shared',
    handler: (deps) => deps.status(),
  },
  {
    name: 'get_live_now',
    description: '当前正在直播的监听主播列表（标题/分区/开播时间/在线人数）',
    schema: {},
    role: 'shared',
    handler: (deps) => {
      const rs = deps.db.listRoomStatesFull();
      return deps.db.listStreamers()
        .filter((s) => s.watch)
        .map((s) => {
          const r = rs.get(s.uid);
          if (!r?.isLive) return null;
          return {
            uid: s.uid, name: s.alias ?? s.uname, roomId: s.roomId ?? r.roomId,
            title: r.title, areaName: r.areaName, parentAreaName: r.parentAreaName,
            liveTime: r.liveTime, online: r.online,
          };
        })
        .filter((x) => x !== null);
    },
  },
  {
    name: 'get_schedule',
    description: '过往直播时间表（北京时间凌晨 6 点日界）。from/to 为 YYYY-MM-DD，缺省 = 今天-7 ~ 今天+1，跨度 ≤62 天',
    schema: {
      from: z.string().optional().describe('起始日 YYYY-MM-DD（缺省今天-7）'),
      to: z.string().optional().describe('结束日 YYYY-MM-DD（缺省今天+1）'),
    },
    role: 'shared',
    handler: (deps, args) =>
      scheduleInfo(deps.db, (args.from as string | undefined) ?? null, (args.to as string | undefined) ?? null),
  },
  {
    name: 'list_streamers',
    description: '监听名单：uid/昵称/别名/直播间号/watch 监听开关/微博昵称（名单内即监听中）',
    schema: {},
    role: 'shared',
    handler: (deps) =>
      deps.db.listStreamers().map((s) => ({
        uid: s.uid, uname: s.uname, alias: s.alias, roomId: s.roomId,
        watch: s.watch, weiboNick: s.weiboNick, profileNote: s.profileNote,
      })),
  },
  {
    name: 'search_streamers',
    description: '按昵称/别名/uid 模糊搜索主播（先搜监听名单，再搜关注候选池）。「把某主播推到群里」前先拿它确认 uid',
    schema: { query: z.string().min(1, 'query 不能为空').describe('昵称/别名/uid 片段') },
    role: 'shared',
    handler: (deps, args) => {
      const q = (args.query as string).trim().toLowerCase();
      const out: Array<{ uid: string; uname: string; alias: string | null; watched: boolean; inPool: boolean }> = [];
      for (const s of deps.db.listStreamers()) {
        if (s.uid === q || s.uname.toLowerCase().includes(q) || (s.alias ?? '').toLowerCase().includes(q)) {
          out.push({ uid: s.uid, uname: s.uname, alias: s.alias, watched: s.watch, inPool: true });
        }
      }
      for (const f of deps.db.listFollows(true)) {
        if (out.length >= 20) break;
        if (out.some((o) => o.uid === f.uid)) continue;
        if (f.uid === q || f.uname.toLowerCase().includes(q)) {
          out.push({ uid: f.uid, uname: f.uname, alias: null, watched: false, inPool: true });
        }
      }
      return out.slice(0, 20);
    },
  },
  {
    name: 'list_push_rules',
    description: '推送规则列表（全局 sort 序；含开播与图文两类）：内容形态 × 分类引用（null=任意内容）× 生效范围（scope 空=全部生效）× 渠道 × 推送词；'
      + 'createdBy=mcp 的是渠道自助规则。gateway 令牌只能看到推送给**本渠道**的规则'
      + '（含与其他渠道共享的多渠道规则，那类带 sharedWithOtherChannels=true）',
    schema: {},
    role: 'shared',
    handler: (deps, _args, ctx) => {
      const rules = deps.db.listPushRules();
      const ch = scopeChannelForRead(ctx);
      if (ch === undefined) return rules; // admin / 面板：全量（行为与改造前一致）
      // 读侧服务端裁剪（plan「渠道隔离」第 2 条）：别的渠道的规则不进调用方上下文
      return rules
        .filter((r) => r.channels.includes(ch))
        .map((r) => ({ ...r, sharedWithOtherChannels: r.channels.length > 1 }));
    },
  },
  {
    name: 'list_categories',
    description: '内容分类定义：判定模式（judgeMode=simple 用判定描述 llmPrompt / precise 用逐条精确条件 judgeConditions）+ 确定性条件组（condMode 且/或）；'
      + '两种模式的数据同时保留，切模式不清空对方；appliesTo=live=直播分类 / post=图文分类',
    schema: {},
    role: 'shared',
    handler: (deps) => deps.db.listCategories(),
  },
  {
    name: 'get_content_audit',
    description: '回看一份内容的分类标准、结论、模型回退、规则命中与发送结果；无记录不等于未推送',
    schema: { subjectType: z.enum(['live', 'post']), subjectId: z.string().min(1).max(256) },
    role: 'admin',
    handler: (deps, args) => ({ audit: deps.db.getContentAudit(args.subjectType as 'live' | 'post', args.subjectId as string),
      verdicts: deps.db.listVerdicts(args.subjectType as 'live' | 'post', args.subjectId as string),
      primary: deps.db.listPrimaryVerdicts(args.subjectType as 'live' | 'post', args.subjectId as string) }),
  },
  {
    name: 'list_channels',
    description: '推送渠道列表：toast=系统通知，onebot=QQ（targetType group/private + targetId 群号/QQ号）。'
      + 'gateway 令牌只能看到本渠道这一条（别的渠道不在可见范围内）',
    schema: {},
    role: 'shared',
    handler: (deps, _args, ctx) => {
      const all = deps.db.listPushChannels();
      const ch = scopeChannelForRead(ctx);
      return ch === undefined ? all : all.filter((c) => c.id === ch);
    },
  },
  {
    name: 'search_posts',
    description: '检索动态/微博/推特归档（uid/平台/正文关键词过滤，按发布时间倒序，limit ≤50）',
    schema: {
      uid: uidSchema.optional().describe('作者标识（B站动态/微博=账号名单的 uid；推特=screen name）'),
      platform: z.enum(['bili_dynamic', 'weibo', 'twitter']).optional(),
      keyword: z.string().optional().describe('正文子串（SQLite LIKE：ASCII 大小写不敏感，其余精确）'),
      limit: z.number().int().min(1).max(50).optional().describe('返回条数，缺省 20'),
    },
    role: 'shared',
    handler: (deps, args) =>
      deps.db.searchPosts({
        uid: args.uid as string | undefined,
        platform: args.platform as string | undefined,
        keyword: args.keyword as string | undefined,
        limit: args.limit as number | undefined,
      }).map(({ raw: _raw, ...p }) => p), // raw 整 item 不下发
  },
  {
    name: 'list_x_accounts',
    description: 'X/推特 关注账号名单（独立于 B站主播；含启用状态、最近推文时间、可选关联主播）',
    schema: {},
    role: 'shared',
    handler: (deps) => ({
      accounts: deps.db.listXAccounts().map((a) => {
        const bili = a.biliUid ? deps.db.getStreamer(a.biliUid) : undefined;
        return { ...a, biliName: bili ? (bili.alias || bili.uname || a.biliUid) : null };
      }),
    }),
  },
  {
    name: 'list_weibo_accounts',
    description: '微博 关注账号名单（独立于 B站主播；含启用状态、可选关联主播）',
    schema: {},
    role: 'shared',
    handler: (deps) => ({
      accounts: deps.db.listWeiboAccounts().map((a) => {
        const bili = a.biliUid ? deps.db.getStreamer(a.biliUid) : undefined;
        return { ...a, biliName: bili ? (bili.alias || bili.uname || a.biliUid) : null };
      }),
    }),
  },
  {
    name: 'list_bili_accounts',
    description: 'B站动态账号名单（账号本身就是主播，uid 即身份锚点；含启用状态、最近抓取时间）',
    schema: {},
    role: 'shared',
    handler: (deps) => ({ accounts: deps.db.listBiliAccounts() }),
  },
  // 撤销是**内部工具**（计划「撤销的用户面」）：不设专门命令，agent 侧自然语言说「撤销刚才那个」即可。
  // 两个角色都该有——admin 撤全局栈，gateway 撤本渠道栈（调用域由令牌解析，不在参数里）。
  // 唯一的写工具塞在 shared 里：ToolRole 是按角色过滤的，要让两种角色都看得见只能用 shared。
  {
    name: 'undo_last_change',
    description: '撤销最近一次配置变更（本调用域的栈顶：admin 撤全局栈，gateway 撤本渠道栈）。'
      + '逐行比对后像与当前值，若该设置已被其他入口改过则中止且一行都不动（宁中止不丢写）；'
      + '撤销会触发热生效（等同于在面板上改回来）。撤回的是上一次写，不是「把某项改回默认」',
    schema: {},
    role: 'shared',
    write: true,
    // 撤销是把已记录的前像写回去，不能再进快照（否则撤销自己成了下一条可撤销记录）
    track: false,
    handler: (deps, _args, ctx) => {
      if (!deps.undoLast) throw new HttpError(400, '撤销未装配');
      const r = deps.undoLast(undoScopeOf(ctx));
      if (!r.ok) {
        if (r.reason === 'empty') throw new HttpError(404, '没有可撤销的变更');
        throw new HttpError(409, '该设置已被其他入口修改，无法撤销本次');
      }
      return {
        ok: true,
        change: { id: r.id, tool: r.tool ?? null },
        applied: r.applied,
        // 隐私例外（LLM key）：值没落库，撤销 = 清空；这里点名要重填的字段
        ...(r.refill ? { refill: r.refill } : {}),
      };
    },
  },
];

// ---- admin 专属（写设置/名单/规则/渠道/LLM）----

const adminTools: McpToolDef[] = [
  {
    name: 'watch_streamer',
    description: '把主播加入监听（已在名单则重新打开 watch；不在则从关注候选池预填昵称/头像新建）',
    schema: { uid: uidSchema },
    role: 'admin',
    write: true,
    handler: (deps, args) => watchStreamer(deps.db, args.uid as string),
  },
  {
    name: 'unwatch_streamer',
    description: '停止监听某主播（保留条目，watch=false；追踪停止但历史数据保留）',
    schema: { uid: uidSchema },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const uid = args.uid as string;
      if (!deps.db.getStreamer(uid)) throw new HttpError(404, '该 uid 不在监听名单');
      deps.db.upsertStreamer({ uid, watch: false });
      return { streamer: deps.db.getStreamer(uid) };
    },
  },
  {
    name: 'set_streamer',
    description: '更新监听名单条目：alias 别名 / watch 监听 / analyze 分析 / notify 通知 / weiboNick 微博昵称（自动解析 uid，传 null 清除）/ profileNote 备注。至少传一个字段',
    schema: {
      uid: uidSchema,
      alias: z.string().nullable().optional(),
      watch: z.boolean().optional(),
      analyze: z.boolean().optional(),
      notify: z.boolean().optional(),
      weiboNick: z.string().nullable().optional().describe('微博昵称；传 null 清除（连同 weiboUid）'),
      profileNote: z.string().nullable().optional(),
    },
    role: 'admin',
    write: true,
    handler: async (deps, args) => {
      const uid = args.uid as string;
      const prev = deps.db.getStreamer(uid);
      if (!prev) throw new HttpError(404, '该 uid 不在监听名单');
      const patch = parseStreamerPatch(
        pickBody(args, ['alias', 'watch', 'analyze', 'notify', 'weiboNick', 'profileNote']),
      );
      // weiboNick → weiboUid 解析（同面板 resolveWeiboNick 语义，内联避免模块循环依赖）
      if (patch.weiboNick !== undefined) {
        if (patch.weiboNick === null || patch.weiboNick === '') {
          patch.weiboNick = null;
          patch.weiboUid = null;
        } else if (patch.weiboNick !== prev.weiboNick) {
          if (!deps.weiboResolver) throw new HttpError(400, '微博解析不可用');
          let weiboUid: string | null;
          try {
            weiboUid = await deps.weiboResolver.resolveUid(patch.weiboNick);
          } catch (e) {
            throw new HttpError(400, `微博昵称解析失败：${e instanceof Error ? e.message : String(e)}`);
          }
          if (weiboUid === null) throw new HttpError(400, '微博上找不到这个昵称');
          patch.weiboUid = weiboUid;
        }
      }
      deps.db.upsertStreamer({ uid, ...patch });
      // 微博独立名单联动（与面板 PUT /api/streamers 共用一份逻辑：填昵称则建/关联网名单行）
      syncStreamerWeiboLink(deps.db, uid, patch);
      return { streamer: deps.db.getStreamer(uid) };
    },
  },
  {
    name: 'set_push_enabled',
    description: '推送总开关（关 = 全局不推送，追踪照常）',
    schema: { enabled: z.boolean() },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      setPushEnabled(deps.db, args.enabled as boolean);
      return { ok: true, enabled: args.enabled };
    },
  },
  {
    name: 'set_llm_enabled',
    description: 'LLM 分析总开关（关 = 分类判定全部回退确定性条件）',
    schema: { enabled: z.boolean() },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      setLlmEnabled(deps.db, args.enabled as boolean);
      return { ok: true, enabled: isLlmEnabled(deps.db) };
    },
  },
  {
    name: 'set_decision_enabled',
    description: '决策模型判定总开关（关 = 判决链跳过决策档，未定案项直接交 LLM）',
    schema: { enabled: z.boolean() },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      setDecisionEnabled(deps.db, args.enabled as boolean);
      return { ok: true, enabled: isDecisionEnabled(deps.db) };
    },
  },
  {
    name: 'set_listen',
    description: '监听功能开关（dynamic=B站动态 / weibo=微博时间线 / twitter=X 推特）。与 auto 默认一致时回 auto，否则落手动值；保存即热启停对应源',
    schema: {
      feature: z.enum(['dynamic', 'weibo', 'twitter']),
      enabled: z.boolean(),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      if (!deps.listen) throw new HttpError(400, '监听开关未装配');
      const feature = args.feature as ListenFeature;
      const ready = deps.listen.login();
      const enabled = setListen(deps.db, feature, args.enabled as boolean, listenReadyFor(feature, ready));
      deps.listen.onChanged();
      return { feature, enabled, setting: listenSetting(deps.db, feature) };
    },
  },
  {
    name: 'set_chat_mode',
    description: 'agent 对话的写操作模式：ask = 每个写工具调用前先复述要改什么、等主人确认；'
      + 'auto = 可直接修改并简述结果。面板的「写前询问 / 自动修改」开关用它',
    schema: { mode: z.enum(['ask', 'auto']) },
    role: 'admin',
    write: true,
    handler: (deps, args) => ({
      ok: true,
      mode: setChatWriteMode(deps.db, args.mode as ChatWriteMode),
    }),
  },
  {
    name: 'set_chat_provider',
    description: 'agent 对话用哪个 LLM provider 回答（空串 = 自动路由，按 provider 顺序 + 失败降级）。'
      + '点名后不降级：它不可用时直接报错，不会偷偷换别人回答。面板的 Agent 模型选择用它',
    schema: {
      provider: z.string().describe('provider ID；空串 = 自动路由'),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const provider = (args.provider as string).trim();
      if (provider !== '') {
        const list = deps.llm?.store?.list();
        if (list === undefined) throw new HttpError(400, 'LLM provider 管理未装配');
        if (!hasLlmProvider(list, provider)) throw new HttpError(400, `没有这个 LLM provider：${provider}`);
      }
      return { ok: true, provider: setChatProvider(deps.db, provider) };
    },
  },
  {
    name: 'update_runtime_config',
    description: '更新运行时参数（settings 唯一信源，保存即热生效）。只传要改的字段；各字段范围在 schema 里',
    // 字段形状直接从规格表生成，描述即面板文案
    schema: Object.fromEntries([
      ...NUM_SPECS.map((s) => [s.field, z.number().int().min(s.min).max(s.max).optional().describe(s.label)]),
      ...BOOL_SPECS.map((s) => [s.field, z.boolean().optional().describe(s.label)]),
    ]),
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const patch = parseRuntimePatch(args);
      // 跨字段校验在合并后做：只改一端也要拿现状的另一端比对（灰区下界必须低于上界）
      const merged = { ...getRuntimeConfig(deps.db), ...patch };
      if (merged.decisionGrayLowPct >= merged.decisionGrayHighPct) {
        throw new HttpError(
          400,
          `决策灰区下界（${merged.decisionGrayLowPct}%）必须小于上界（${merged.decisionGrayHighPct}%）`,
        );
      }
      saveRuntimeConfig(deps.db, patch);
      deps.advanced?.onChanged();
      return { ok: true, ...getRuntimeConfig(deps.db) };
    },
  },
  // ---- X / 推特（独立分页：连接配置 + 独立账号名单；轴 B「唯一能力信源」的一部分）----
  {
    name: 'get_x_config',
    description: 'X/推特 连接配置与状态快照（代理 / Nitter 实例 / 抓取间隔 / 回退开关；含上次探测结果与源运行状态）',
    schema: {},
    role: 'admin',
    handler: (deps) => {
      if (!deps.x) throw new HttpError(400, 'X 分页未装配');
      return deps.x.info();
    },
  },
  {
    name: 'update_x_config',
    description: '更新 X/推特 连接配置（代理地址 / Nitter 实例 / 抓取间隔 / 免登录回退）。只传要改的字段；保存即热生效',
    schema: {
      proxyUrl: z.string().optional().describe('HTTP 代理，如 http://127.0.0.1:7890；空串 = 不用代理'),
      instances: z.string().optional().describe('Nitter 实例 host，中英文逗号分隔'),
      intervalSec: z.number().int().min(X_INTERVAL_MIN).max(X_INTERVAL_MAX).optional(),
      fallbackHtml: z.boolean().optional().describe('Nitter 全挂时回退到免登录 x.com HTML'),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      if (!deps.x) throw new HttpError(400, 'X 分页未装配');
      deps.x.save(parseXPatch(args));
      deps.x.onChanged();
      return deps.x.info();
    },
  },
  {
    name: 'upsert_x_account',
    description: '新建/更新 X 关注账号（独立名单，不要求对应 B站主播）。带 id = 更新（未传字段保留原值），不带 = 新建；'
      + 'screenName 会归一化（去 @ 转小写）。ID 与平台昵称不可手改：更新时传 screenName / nickname 会被拒绝'
      + '（昵称由添加时校验种入、抓取回写；要换账号就删除后重新添加）',
    schema: {
      id: idSchema.optional(),
      screenName: z.string().optional().describe('X 账号（@ 可省）；新建必填，更新时不可改'),
      nickname: z.string().nullable().optional().describe('已退役：昵称是平台事实（校验种入 / 抓取回写），不接受手填；传入会被拒绝'),
      displayName: z.string().nullable().optional().describe('自定义显示名（卡片优先展示；留空 = 用昵称）'),
      biliUid: uidSchema.nullable().optional().describe('可选关联主播 uid；null = 取消关联'),
      enabled: z.boolean().optional(),
    },
    role: 'admin',
    write: true,
    handler: async (deps, args) => {
      if (args.id === undefined) {
        const input = parseNewXAccount(pickBody(args, ['screenName', 'displayName', 'biliUid', 'enabled']));
        if (args.nickname !== undefined) {
          throw new HttpError(400, '昵称是平台事实（添加校验种入 / 抓取回写），不接受手填');
        }
        if (deps.db.getXAccountByScreenName(input.screenName)) {
          throw new HttpError(409, `@${input.screenName} 已在名单里`);
        }
        checkXBiliUidForMcp(deps, input.biliUid);
        // 存在性校验（与面板 POST /api/x/accounts 同一条）：「账号不存在」是硬错误（多半敲错了）；
        // 链路原因（代理不通 / 限流）照收——不能因为代理没开就让人加不了账号，把原因回报给调用方。
        // verify 顺手抠到的 og:title 显示名直接种入 nickname（抠不到为 null，抓取再回写）
        const verify = deps.x?.verify ? await deps.x.verify(input.screenName) : undefined;
        if (verify?.checked && !verify.ok && verify.kind === 'not-found') {
          throw new HttpError(400, `X 账号不存在：@${input.screenName}`);
        }
        const id = deps.db.upsertXAccount({ ...input, nickname: verify?.name ?? null });
        deps.x?.onChanged();
        return { id, account: deps.db.getXAccount(id), ...(verify ? { verify } : {}) };
      }
      const id = Number(args.id);
      if (!deps.db.getXAccount(id)) throw new HttpError(404, 'X 账号不存在');
      if (args.screenName !== undefined || args.nickname !== undefined) {
        throw new HttpError(400, 'X 的 ID 与昵称是平台事实不可改；要换账号请删除后重新添加');
      }
      const patch = parseXAccountPatch(pickBody(args, ['biliUid', 'displayName', 'enabled']));
      if (patch.biliUid !== undefined) checkXBiliUidForMcp(deps, patch.biliUid);
      deps.db.upsertXAccount({ ...patch, id });
      deps.x?.onChanged();
      return { id, account: deps.db.getXAccount(id) };
    },
  },
  {
    name: 'delete_x_account',
    description: '从 X 名单移除账号（已归档的推文保留在 posts 表里）',
    schema: { id: idSchema },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      if (!deps.db.deleteXAccount(Number(args.id))) throw new HttpError(404, 'X 账号不存在');
      deps.x?.onChanged();
      return { ok: true };
    },
  },
  {
    name: 'upsert_weibo_account',
    description: '新建/更新 微博 关注账号（独立名单，不要求对应 B站主播）。带 id = 更新（未传字段保留原值），不带 = 新建；'
      + '只填 nickname 时走微博昵称解析链补出 uid（需已装配 resolver）。uid 与昵称更新时不可改'
      + '（昵称抓取每轮回写；要换账号就删除后重新添加）',
    schema: {
      id: idSchema.optional(),
      uid: z.string().optional().describe('微博数字 uid（可从 weibo.com/u/<uid> 复制）；新建时与 nickname 至少给一个，更新时不可改'),
      nickname: z.string().nullable().optional().describe('微博昵称；**新建时**与 uid 至少给一个（给昵称则自动解析 uid）——更新时不可改（平台事实，抓取回写）'),
      displayName: z.string().nullable().optional().describe('自定义显示名（卡片优先展示；留空 = 用昵称）'),
      biliUid: uidSchema.nullable().optional().describe('可选关联主播 uid；null = 取消关联'),
      enabled: z.boolean().optional(),
    },
    role: 'admin',
    write: true,
    handler: async (deps, args) => {
      if (args.id === undefined) {
        const input = parseNewWeiboAccount(pickBody(args, ['uid', 'nickname', 'displayName', 'biliUid', 'enabled']));
        let uid = input.uid;
        if (!uid) {
          if (!deps.weiboResolver) throw new HttpError(400, '微博解析不可用，请直接填 uid');
          try {
            uid = await deps.weiboResolver.resolveUid(input.nickname!);
          } catch (e) {
            throw new HttpError(400, `微博昵称解析失败：${e instanceof Error ? e.message : String(e)}`);
          }
          if (!uid) throw new HttpError(400, `微博上找不到这个昵称：${input.nickname}`);
        }
        if (deps.db.getWeiboAccountByUid(uid)) throw new HttpError(409, `微博 ${uid} 已在名单里`);
        checkWeiboBiliUidForMcp(deps, input.biliUid);
        const id = deps.db.upsertWeiboAccount({ ...input, uid });
        deps.weibo?.onChanged();
        return { id, account: deps.db.getWeiboAccount(id) };
      }
      const id = Number(args.id);
      if (!deps.db.getWeiboAccount(id)) throw new HttpError(404, '微博账号不存在');
      if (args.uid !== undefined || args.nickname !== undefined) {
        throw new HttpError(400, '微博 uid 与昵称是平台事实不可改（抓取会回写）；要换账号请删除后重新添加');
      }
      const patch = parseWeiboAccountPatch(pickBody(args, ['displayName', 'biliUid', 'enabled']));
      if (patch.biliUid !== undefined) checkWeiboBiliUidForMcp(deps, patch.biliUid);
      deps.db.upsertWeiboAccount({ ...patch, id });
      deps.weibo?.onChanged();
      return { id, account: deps.db.getWeiboAccount(id) };
    },
  },
  {
    name: 'delete_weibo_account',
    description: '从微博名单移除账号（已归档的微博保留在 posts 表里）',
    schema: { id: idSchema },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      if (!deps.db.deleteWeiboAccount(Number(args.id))) throw new HttpError(404, '微博账号不存在');
      deps.weibo?.onChanged();
      return { ok: true };
    },
  },
  {
    name: 'upsert_bili_account',
    description: '新建/更新 B站动态账号（独立名单，只管图文帖推送选用；抓取轮询对象由动态源自动并入监听主播）。'
      + '带 id = 更新（未传字段保留原值），不带 = 新建；uid 可粘贴 space.bilibili.com/<uid> 链接（归一化成纯数字），'
      + '新建必填、更新时不可改；uname 是平台事实（抓取回写），不接受手填',
    schema: {
      id: idSchema.optional(),
      uid: z.string().optional().describe('B站数字 uid 或 space.bilibili.com/<uid> 链接；新建必填，更新时不可改'),
      uname: z.string().nullable().optional().describe('已退役：B站用户名是平台事实（抓取回写），不接受手填；传入会被拒绝'),
      displayName: z.string().nullable().optional().describe('自定义显示名（卡片优先展示；留空 = 用用户名）'),
      enabled: z.boolean().optional(),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      if (args.uname !== undefined) {
        throw new HttpError(400, 'B站用户名是平台事实（抓取回写），不接受手填');
      }
      if (args.id === undefined) {
        const input = parseNewBiliAccount(pickBody(args, ['uid', 'displayName', 'enabled']));
        if (deps.db.getBiliAccountByUid(input.uid)) throw new HttpError(409, `uid ${input.uid} 已在名单里`);
        const id = deps.db.upsertBiliAccount(input);
        return { id, account: deps.db.getBiliAccount(id) };
      }
      const id = Number(args.id);
      if (!deps.db.getBiliAccount(id)) throw new HttpError(404, 'B站动态账号不存在');
      if (args.uid !== undefined) {
        throw new HttpError(400, 'uid 是身份锚点不可改；要换账号请删除后重新添加');
      }
      const patch = parseBiliAccountPatch(pickBody(args, ['displayName', 'enabled']));
      deps.db.upsertBiliAccount({ ...patch, id });
      return { id, account: deps.db.getBiliAccount(id) };
    },
  },
  {
    name: 'delete_bili_account',
    description: '从 B站动态名单移除账号（已归档的动态保留在 posts 表里）',
    schema: { id: idSchema },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      if (!deps.db.deleteBiliAccount(Number(args.id))) throw new HttpError(404, 'B站动态账号不存在');
      return { ok: true };
    },
  },
  {
    name: 'upsert_category',
    description: '新建/更新内容分类（判定口径 + 确定性条件组，至少一项非空）。带 id = 更新（未传字段保留原值），不带 = 新建。'
      + 'judgeMode=simple（默认）：用一句判定描述 llmPrompt；judgeMode=precise：用逐条精确条件 judgeConditions'
      + '（正向任一成立即支持、负向任一成立即否决；没有启用正向条件时该分类不进模型判定）。'
      + '两种模式的数据都保存，切模式不清空对方。'
      + 'appliesTo=live（默认）：关键词/分区条件；appliesTo=post：关键词/帖子类型/引用/带图条件（图文 filters 已上移进分类）',
    schema: {
      id: idSchema.optional(),
      name: z.string().optional(),
      llmPrompt: z.string().nullable().optional().describe('判定描述（简单模式的判定口径）；null/空串 = 无描述'),
      judgeMode: z.enum(['simple', 'precise']).optional().describe('判定模式：simple=一句判定描述 / precise=逐条精确条件'),
      judgeConditions: judgeConditionsSchema.optional(),
      keywords: z.array(z.string()).optional().describe('标题/正文关键词，命中任一即可'),
      areas: z.array(z.string()).optional().describe('分区（仅直播分类）'),
      appliesTo: z.enum(['live', 'post']).optional().describe('分类服务的内容类型：live=直播场次 / post=图文帖；新建后不可更改'),
      postTypes: z.array(z.enum(['original', 'retweet'])).optional()
        .describe('帖子类型条件（仅图文分类）：勾选集合，空 = 不限'),
      requireQuote: z.boolean().optional().describe('必须是引用帖（仅图文分类；只有 X 帖可能命中）'),
      requireMedia: z.boolean().optional().describe('必须带图（仅图文分类）'),
      condMode: z.enum(['and', 'or']).optional().describe('各条件组之间的关系：and=都中 / or=任一中'),
      primary: z.boolean().optional().describe('是否加入主分类组（时间表等展示用的单选分类）'),
      enabled: z.boolean().optional(),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const keys = [
        'name', 'llmPrompt', 'judgeMode', 'judgeConditions', 'keywords', 'areas', 'appliesTo', 'postTypes',
        'requireQuote', 'requireMedia', 'condMode', 'primary', 'enabled',
      ] as const;
      if (args.id === undefined) {
        const c = parseNewCategory(pickBody(args, keys));
        return { id: deps.db.upsertCategory(c) };
      }
      const id = args.id as number;
      const prev = deps.db.listCategories().find((c) => c.id === id);
      if (!prev) throw new HttpError(404, '分类不存在');
      const patch = parseCategoryPatch(pickBody(args, keys));
      if (patch.appliesTo !== undefined && patch.appliesTo !== prev.appliesTo) {
        throw new HttpError(400, '分类的内容类型不可更改，请在对应页面新增分类');
      }
      // 条件校验对合并后的形状做（同面板 PUT）
      checkCategoryConditions({
        appliesTo: prev.appliesTo,
        judgeMode: patch.judgeMode ?? prev.judgeMode,
        llmPrompt: patch.llmPrompt !== undefined ? patch.llmPrompt : prev.llmPrompt,
        judgeConditions: patch.judgeConditions ?? prev.judgeConditions,
        keywords: patch.keywords ?? prev.keywords,
        areas: patch.areas ?? prev.areas,
        postTypes: patch.postTypes ?? prev.postTypes,
        requireQuote: patch.requireQuote ?? prev.requireQuote,
        requireMedia: patch.requireMedia ?? prev.requireMedia,
      });
      deps.db.upsertCategory({ id, ...patch });
      return { ok: true };
    },
  },
  {
    name: 'delete_category',
    description: '删除分类（级联停用引用它的推送规则，返回停用条数）',
    schema: { id: idSchema },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const id = args.id as number;
      if (!deps.db.listCategories().some((c) => c.id === id)) throw new HttpError(404, '分类不存在');
      // 级联停用 + 删除一个事务（P0：撤销快照的前提——两条语句不再可能只成一半）
      const disabledRules = deps.db.transaction(() => {
        const n = deps.db.disablePushRulesByCategory(id);
        deps.db.deleteCategory(id);
        return n;
      });
      return { ok: true, disabledRules };
    },
  },
  {
    name: 'upsert_push_rule',
    description: '新建/更新推送规则（统一规则：subjectKind 内容形态 × 分类引用 null=任意内容 × scope 空=全部生效 × 渠道 × 推送词 × 附加动作）。'
      + '带 id = 更新，不带 = 新建。分类/渠道/生效主体引用必须存在；'
      + 'subjectKind=live（默认）：scope=主播 uid 列表；subjectKind=post：scope=账号引用（twitter:账号 / weibo:uid / bili:uid）',
    schema: {
      id: idSchema.optional(),
      name: z.string().optional(),
      subjectKind: z.enum(['live', 'post']).optional().describe('规则服务的内容形态：live=开播 / post=图文帖'),
      categoryId: idSchema.nullable().optional().describe('分类 id；null = 任意内容（按 subjectKind 匹配分类的 appliesTo）'),
      scope: z.array(z.string()).optional()
        .describe('生效主体集合；空数组 = 全部生效。live=主播 uid；post=账号引用（twitter:账号 / weibo:uid / bili:uid）'),
      uids: z.array(uidSchema).optional().describe('旧字段已退役，请改用 scope；传入此字段会拒绝保存'),
      channels: z.array(idSchema).optional(),
      messageTemplate: z.string().nullable().optional()
        .describe('推送词；live 用 {liver}/{uname}/{title}，post 用 {author}/{text}/{url}/{liver}；null = 内置默认'),
      llmTranslate: z.boolean().optional().describe('附加动作：推送时附 LLM 译文（仅 X 帖运行时生效）'),
      enabled: z.boolean().optional(),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const keys = ['name', 'subjectKind', 'categoryId', 'scope', 'channels', 'messageTemplate', 'llmTranslate', 'enabled'] as const;
      if (args.uids !== undefined) throw new HttpError(400, 'uids 已退役，请改用 scope；为避免扩大生效范围，本次未保存');
      if (args.id === undefined) {
        const rule = parseNewRule(pickBody(args, keys));
        checkRuleRefs(deps.db, rule);
        return { id: deps.db.upsertPushRule(rule) };
      }
      const id = args.id as number;
      const prev = deps.db.listPushRules().find((r) => r.id === id);
      if (!prev) throw new HttpError(404, '规则不存在');
      const patch = parseRulePatch(pickBody(args, keys));
      // 存在性校验对合并后的形状做（同面板 PUT）
      checkRuleRefs(deps.db, {
        subjectKind: patch.subjectKind ?? prev.subjectKind,
        categoryId: patch.categoryId !== undefined ? patch.categoryId : prev.categoryId,
        scope: patch.scope ?? prev.scope,
        channels: patch.channels ?? prev.channels,
      });
      deps.db.upsertPushRule({ id, ...patch });
      return { ok: true };
    },
  },
  {
    name: 'delete_push_rule',
    description: '删除推送规则',
    schema: { id: idSchema },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      if (!deps.db.deletePushRule(args.id as number)) throw new HttpError(404, '规则不存在');
      return { ok: true };
    },
  },
  {
    name: 'upsert_channel',
    description: '新建/更新推送渠道（toast=系统通知；onebot=QQ，需 targetType group/private + targetId 纯数字）。带 id = 更新，不带 = 新建',
    schema: {
      id: idSchema.optional(),
      name: z.string().optional(),
      notifier: z.enum(['toast', 'onebot']).optional(),
      targetType: z.enum(['group', 'private']).nullable().optional(),
      targetId: z.string().regex(/^\d+$/, 'targetId 必须是纯数字').nullable().optional(),
      enabled: z.boolean().optional(),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const keys = ['name', 'notifier', 'targetType', 'targetId', 'enabled'] as const;
      if (args.id === undefined) {
        const c = parseNewChannel(pickBody(args, keys));
        return { id: deps.db.upsertPushChannel(c) };
      }
      const id = args.id as number;
      const prev = deps.db.listPushChannels().find((c) => c.id === id);
      if (!prev) throw new HttpError(404, '渠道不存在');
      const patch = parseChannelPatch(pickBody(args, keys));
      checkChannelShape({
        notifier: patch.notifier ?? prev.notifier,
        targetType: patch.targetType !== undefined ? patch.targetType : prev.targetType,
        targetId: patch.targetId !== undefined ? patch.targetId : prev.targetId,
      });
      deps.db.upsertPushChannel({ id, ...patch });
      return { ok: true };
    },
  },
  {
    name: 'delete_channel',
    description: '删除推送渠道（引用它的规则会失去该渠道）',
    schema: { id: idSchema },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const id = args.id as number;
      if (!deps.db.listPushChannels().some((c) => c.id === id)) throw new HttpError(404, '渠道不存在');
      deps.db.deletePushChannel(id);
      return { ok: true };
    },
  },
  {
    name: 'list_llm_providers',
    description: 'LLM provider 名单与总开关（key 只显示个数，不回显值）',
    schema: {},
    role: 'admin',
    handler: (deps) => ({
      enabled: isLlmEnabled(deps.db),
      providers: (deps.llm?.store?.list() ?? []).map((p) => ({
        ...p,
        keyCount: splitCsvText(deps.db.getSetting(llmKeySetting(p.id))).length,
      })),
    }),
  },
  {
    name: 'upsert_llm_provider',
    description: '新增/更新 LLM provider（按 id 定位，name 可改）。新建需 name+baseURL+model；可顺带传 key。保存后路由热重建',
    schema: {
      id: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      baseURL: z.string().optional(),
      model: z.string().optional(),
      vision: z.boolean().optional(),
      enabled: z.boolean().optional(),
      structuredOutput: z.enum(['schema', 'object', 'none']).optional(),
      api: z.enum(['chat-completions', 'responses']).optional(),
      keyEnvs: z.array(z.string().min(1)).optional().describe('从环境变量读 key 的变量名列表（通常留空，key 直接走 key 字段）'),
      key: z.string().optional().describe('API key（多个用逗号分隔，中英文逗号均可）；空串 = 清除'),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const store = deps.llm?.store;
      if (!store) throw new HttpError(400, 'LLM provider 管理未装配');
      const list = store.list();
      const prev = args.id === undefined ? undefined : list.find((p) => p.id === args.id);
      if (args.id !== undefined && !prev) throw new HttpError(404, 'provider 不存在');
      const patch = pickBody(args, ['name', 'baseURL', 'model', 'vision', 'keyEnvs', 'enabled', 'structuredOutput', 'api']);
      const merged = prev ? { ...prev, ...patch } : { id: randomUUID(), ...patch };
      const parsed = llmProviderSchema.safeParse(merged);
      if (!parsed.success) {
        const msg = parsed.error.issues
          .map((i) => `${i.path.length ? i.path.join('.') : '(根)'}: ${i.message}`).join('；');
        throw new HttpError(400, `provider 校验失败：${msg}`);
      }
      const provider = parsed.data;
      if (list.some((p) => p.id !== provider.id && p.name === provider.name)) {
        throw new HttpError(400, `provider name 重复: ${provider.name}`);
      }
      store.save(prev
        ? list.map((p) => (p.id === provider.id ? provider : p))
        : [...list, provider]);
      // key 可随表单一并提交（同面板弹窗体验）；空串 = 清除；中文逗号归一成英文逗号落库
      if (typeof args.key === 'string') {
        deps.db.setSetting(llmKeySetting(provider.id), normalizeCsvText(args.key.trim()));
        deps.llm?.router?.refreshKeys();
      }
      deps.llm?.onProvidersChanged?.();
      return { ok: true, id: provider.id, name: provider.name };
    },
  },
  {
    name: 'delete_llm_provider',
    description: '删除 LLM provider（不动已存的 key 设置项）',
    schema: { id: z.string().min(1) },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const store = deps.llm?.store;
      if (!store) throw new HttpError(400, 'LLM provider 管理未装配');
      const list = store.list();
      if (!list.some((p) => p.id === args.id)) throw new HttpError(404, 'provider 不存在');
      store.save(list.filter((p) => p.id !== args.id));
      deps.llm?.onProvidersChanged?.();
      return { ok: true };
    },
  },
  {
    name: 'set_llm_key',
    description: '设置/清除某 provider 的 API key（多个用逗号分隔，中英文逗号均可；空串 = 清除）。保存即热更新',
    schema: {
      id: z.string().min(1),
      value: z.string().describe('key 值；空串 = 清除'),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const id = args.id as string;
      const value = normalizeCsvText((args.value as string).trim());
      const list = deps.llm?.store?.list() ?? [];
      if (!list.some((p) => p.id === id)) throw new HttpError(404, `provider 不存在: ${id}`);
      if (value && !/^[^\s,]+(\s*,\s*[^\s,]+)*$/.test(value)) {
        throw new HttpError(400, '多个 key 用逗号分隔（中英文逗号均可），key 内不能有空格');
      }
      deps.db.setSetting(llmKeySetting(id), value);
      deps.llm?.router?.refreshKeys();
      return { ok: true, provider: id };
    },
  },
  // ---- 决策模型供应商（System One 通道管理面；与 LLM provider 完全隔离）----
  {
    name: 'list_decision_providers',
    description: '决策模型供应商名单（key 只显示个数，不回显值；协议目前只有 systemone）',
    schema: {},
    role: 'admin',
    handler: (deps) => ({
      providers: (deps.decision?.store.list() ?? []).map((p) => ({
        ...p,
        keyCount: dbDecisionKeysOf(deps.db)(p).length,
      })),
    }),
  },
  {
    name: 'upsert_decision_provider',
    description: '新增/更新决策模型供应商（按 id 定位，name 可改）。新建需 name+baseURL+model；'
      + 'protocol 目前只有 systemone（Jev /v1/systemone 线格式）；vision = 该端点能否接含图请求'
      + '（带图内容优先交给 vision 供应商）。可顺带传 key；保存后判定路由立即重建',
    schema: {
      id: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      baseURL: z.string().optional(),
      model: z.string().optional(),
      protocol: z.enum(['systemone']).optional().describe('端点协议；当前只有 systemone'),
      vision: z.boolean().optional().describe('可接含图请求（带图内容优先交给它）'),
      enabled: z.boolean().optional(),
      key: z.string().optional().describe('API key（多个用逗号分隔，中英文逗号均可）；空串 = 清除'),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const store = deps.decision?.store;
      if (!store) throw new HttpError(400, '决策模型供应商管理未装配');
      const list = store.list();
      const prev = args.id === undefined ? undefined : list.find((p) => p.id === args.id);
      if (args.id !== undefined && !prev) throw new HttpError(404, 'provider 不存在');
      const patch = pickBody(args, ['name', 'baseURL', 'model', 'protocol', 'vision', 'enabled']);
      const merged = prev ? { ...prev, ...patch } : { id: randomUUID(), ...patch };
      const parsed = decisionProviderSchema.safeParse(merged);
      if (!parsed.success) {
        const msg = parsed.error.issues
          .map((i) => `${i.path.length ? i.path.join('.') : '(根)'}: ${i.message}`).join('；');
        throw new HttpError(400, `provider 校验失败：${msg}`);
      }
      const provider = parsed.data;
      if (list.some((p) => p.id !== provider.id && p.name === provider.name)) {
        throw new HttpError(400, `provider name 重复: ${provider.name}`);
      }
      store.save(prev
        ? list.map((p) => (p.id === provider.id ? provider : p))
        : [...list, provider]);
      // key 与 LLM 同款：随表单一并提交，空串 = 清除，中文逗号归一成英文逗号落库
      if (typeof args.key === 'string') {
        deps.db.setSetting(decisionKeySetting(provider.id), normalizeCsvText(args.key.trim()));
      }
      // 名单与 key 都在 router 构造时快照：写完立刻重建，判定档下一轮就用新名单
      deps.decision?.onProvidersChanged?.();
      return { ok: true, id: provider.id, name: provider.name };
    },
  },
  {
    name: 'delete_decision_provider',
    description: '删除决策模型供应商（不动已存的 key 设置项）',
    schema: { id: z.string().min(1) },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const store = deps.decision?.store;
      if (!store) throw new HttpError(400, '决策模型供应商管理未装配');
      const list = store.list();
      if (!list.some((p) => p.id === args.id)) throw new HttpError(404, 'provider 不存在');
      store.save(list.filter((p) => p.id !== args.id));
      deps.decision?.onProvidersChanged?.();
      return { ok: true };
    },
  },
  // ---- 排序与测试类（P0 补齐：与对应 REST 路由同一套校验与 Db 调用；
  // 进注册表是为纳入回滚覆盖/审计，agent 工具面由 AGENT_EXCLUDED_TOOLS 排除）----
  {
    name: 'reorder_channels',
    description: '推送渠道排序：ids 必须是现有渠道 id 的全排列（长度一致/无重复/无增删），按数组顺序重写展示顺序',
    schema: { ids: z.array(idSchema) },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const ids = args.ids as number[];
      checkFullPermutation(ids, deps.db.listPushChannels().map((c) => c.id), '渠道');
      deps.db.reorderPushChannels(ids);
      return { ok: true };
    },
  },
  {
    name: 'reorder_categories',
    description: '内容分类排序：ids 必须是现有分类 id 的全排列（长度一致/无重复/无增删），按数组顺序重写展示顺序',
    schema: { ids: z.array(idSchema) },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const ids = args.ids as number[];
      checkFullPermutation(ids, deps.db.listCategories().map((c) => c.id), '分类');
      deps.db.reorderCategories(ids);
      return { ok: true };
    },
  },
  {
    name: 'reorder_push_rules',
    description: '推送规则排序：ids 必须是全部规则 id 的全排列（长度一致/无重复/无增删），按数组顺序重写全局匹配优先级',
    schema: { ids: z.array(idSchema) },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const ids = args.ids as number[];
      checkFullPermutation(ids, deps.db.listPushRules().map((r) => r.id), '规则');
      deps.db.reorderPushRules(ids);
      return { ok: true };
    },
  },
  {
    name: 'reorder_llm_providers',
    description: 'LLM provider 排序：ids 必须是现有 provider ID 的一个排列（长度一致/无重复/无增删）；顺序 = 路由优先级，保存后路由热重建',
    schema: { ids: z.array(z.string().min(1)) },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const store = deps.llm?.store;
      if (!store) throw new HttpError(400, 'LLM provider 管理未装配');
      const ids = args.ids as string[];
      if (new Set(ids).size !== ids.length) throw new HttpError(400, 'ids 有重复');
      const list = store.list();
      const byId = new Map(list.map((p) => [p.id, p]));
      if (ids.length !== list.length || ids.some((id) => !byId.has(id))) {
        throw new HttpError(400, 'ids 必须与现有 provider 名单一一对应');
      }
      store.save(ids.map((id) => byId.get(id)!));
      deps.llm?.onProvidersChanged?.();
      return { ok: true };
    },
  },
  {
    name: 'reorder_decision_providers',
    description: '决策模型供应商排序：ids 必须是现有 provider ID 的一个排列（长度一致/无重复/无增删）；顺序 = 判定档的调用优先级（带图内容先试 vision 供应商，再按名单序试纯文本供应商）',
    schema: { ids: z.array(z.string().min(1)) },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const store = deps.decision?.store;
      if (!store) throw new HttpError(400, '决策模型供应商管理未装配');
      const ids = args.ids as string[];
      if (new Set(ids).size !== ids.length) throw new HttpError(400, 'ids 有重复');
      const list = store.list();
      const byId = new Map(list.map((p) => [p.id, p]));
      if (ids.length !== list.length || ids.some((id) => !byId.has(id))) {
        throw new HttpError(400, 'ids 必须与现有 provider 名单一一对应');
      }
      store.save(ids.map((id) => byId.get(id)!));
      deps.decision?.onProvidersChanged?.();
      return { ok: true };
    },
  },
  {
    name: 'test_decision_provider',
    description: '测试某个决策模型供应商：发一次最小 systemone 请求，返回毫秒耗时与响应回显的模型版本；失败 502',
    schema: { id: z.string().min(1) },
    role: 'admin',
    write: true,
    handler: async (deps, args) => {
      const dep = deps.decision;
      if (!dep) throw new HttpError(400, '决策模型供应商管理未装配');
      const spec = dep.store.list().find((p) => p.id === args.id);
      if (!spec) throw new HttpError(404, 'provider 不存在');
      const key = dbDecisionKeysOf(deps.db)(spec)[0] ?? null;
      if (key === null && decisionNeedsAuth(spec)) throw new HttpError(400, '缺 key，请先填写');
      try {
        const r = await dep.probe(spec, key);
        return { ok: true, ms: r.ms, model: r.model };
      } catch (e) {
        // 错误信息只含 HTTP 状态/对端响应摘要，不含 key
        throw new HttpError(502, e instanceof Error ? e.message : String(e));
      }
    },
  },
  {
    name: 'test_push',
    description: '测试推送：假开播消息走完整推送链路（会真发一条消息到所有启用渠道），返回 总数/成功数',
    schema: {},
    role: 'admin',
    write: true,
    handler: async (deps) => {
      if (!deps.testPush) throw new HttpError(400, '测试推送未装配');
      const r = await deps.testPush();
      return { ok: true, ...r };
    },
  },
  {
    name: 'test_llm_provider',
    description: '测试某个 LLM provider：绕过熔断发一个最小 ping，返回毫秒耗时；失败照常计入熔断统计（与面板「测试」按钮同一语义）',
    schema: { id: z.string().min(1) },
    role: 'admin',
    write: true,
    handler: async (deps, args) => {
      const router = deps.llm?.router;
      if (!router) throw new HttpError(400, 'LLM 未装配');
      const id = args.id as string;
      const status = router.providerStatus(id);
      if (status === null) throw new HttpError(404, 'provider 不存在');
      if (status.startsWith('缺 key')) throw new HttpError(400, '缺 key，请先填写');
      try {
        const ms = await router.ping(id);
        return { ok: true, ms };
      } catch (e) {
        // 同 REST 的 502：错误信息只含 HTTP 状态/对端响应摘要，不含 key
        throw new HttpError(502, e instanceof Error ? e.message : String(e));
      }
    },
  },
  {
    name: 'test_x_connection',
    description: 'X/推特 连通性探测（代理 / Nitter 实例 / 免登录回退）。允许传入尚未保存的覆盖值（先测后存）；'
      + '测的就是已保存配置时，探测结果快照写 settings（面板卡片读它）',
    schema: {
      target: z.enum(['all', 'proxy', 'instances', 'web']).optional().describe('探测目标，缺省 all'),
      proxyUrl: z.string().optional().describe('覆盖已保存的代理地址（先测后存）'),
      instances: z.string().optional().describe('覆盖已保存的 Nitter 实例 host（逗号分隔）'),
      screenName: z.string().optional().describe('探测用账号（免登录路线）；缺省用基准账号'),
    },
    role: 'admin',
    write: true,
    handler: async (deps, args) => {
      if (!deps.x) throw new HttpError(400, 'X 分页未装配');
      return deps.x.test(parseXTestRequest(pickBody(args, ['target', 'proxyUrl', 'instances', 'screenName'])));
    },
  },
  {
    name: 'sample_category_records',
    description: '从归档里抽一批内容样本，供分类试判挑选（只读）：kind=live 取直播场次 / kind=post 取图文帖，'
      + '只回摘要（身份键 subjectId、作者、正文、标签、链接、时间、缩略图源图 image）。'
      + '只抽有源图的记录（直播有关键帧或封面、图文有配图）。'
      + '不下图、不调模型、不写库；把选中的 subjectId 原样传给 test_category 的 sampleIds 即可复测同一条内容',
    schema: {
      kind: z.enum(['live', 'post']).describe('样本类型：live = 直播场次；post = 图文帖'),
      uid: z.string().optional().describe('主体过滤：live = 主播 uid；post = 账号标识（X screen name / 微博或B站 uid）'),
      platform: z.enum(['bili_dynamic', 'weibo', 'twitter']).optional().describe('仅 post：限定平台'),
      fromTs: z.number().int().nonnegative().optional().describe('内容时间下限（秒级时间戳）'),
      toTs: z.number().int().nonnegative().optional().describe('内容时间上限（秒级时间戳）'),
      limit: z.number().int().min(1).max(SAMPLE_LIMIT_MAX).optional().describe('样本条数，缺省 10'),
    },
    role: 'admin',
    handler: (deps, args) => {
      const dep = deps.categoryTest;
      if (!dep) throw new HttpError(400, '分类试判未装配');
      return sampleCategoryRecords({ ...dep, db: deps.db }, args);
    },
  },
  {
    name: 'test_category',
    description: '用真实归档的样本试跑一条分类草稿：确定性条件（关键词/分区/帖子类型/引用/带图）、'
      + 'LLM、决策模型三档各自独立判定，只回摘要（样本正文 + 三档结论与理由）。'
      + '不保存分类、不落判定记录、不推送。草稿校验与新建分类同一套（至少一项条件或判定口径）；'
      + 'judgeMode=precise 时模型档按逐条精确条件判，决策档回逐条件概率（conditionResults），'
      + '没有启用正向条件的分类两个模型档都跳过（不回退判定描述）。'
      + 'live 分类取直播场次（filter.uid 可选 = 主播 uid），post 分类取图文帖'
      + '（filter.uid + filter.platform 定位账号）。传 sampleIds = 按这些 subjectId 逐条精确复测'
      + '（顺序照传，忽略 filter）；不传 = 按 filter 随机抽。没填判定口径时两个模型档都跳过',
    schema: {
      category: z.object({
        name: z.string().optional(),
        llmPrompt: z.string().nullable().optional()
          .describe('判定描述（简单模式的判定口径）；null/空串 = 无描述'),
        judgeMode: z.enum(['simple', 'precise']).optional().describe('判定模式：simple=一句判定描述 / precise=逐条精确条件'),
        judgeConditions: judgeConditionsSchema.optional(),
        keywords: z.array(z.string()).optional(),
        areas: z.array(z.string()).optional(),
        appliesTo: z.enum(['live', 'post']).optional(),
        postTypes: z.array(z.enum(['original', 'retweet'])).optional(),
        requireQuote: z.boolean().optional(),
        requireMedia: z.boolean().optional(),
        condMode: z.enum(['and', 'or']).optional(),
        primary: z.boolean().optional(),
      }).optional().describe('草稿分类（形状同 upsert_category，但不会保存）'),
      filter: z.object({
        uid: z.string().optional().describe('主体过滤：live = 主播 uid；post = 账号标识（X screen name / 微博或B站 uid）'),
        platform: z.enum(['bili_dynamic', 'weibo', 'twitter']).optional().describe('仅 post：限定平台'),
        fromTs: z.number().int().nonnegative().optional().describe('内容时间下限（秒级时间戳）'),
        toTs: z.number().int().nonnegative().optional().describe('内容时间上限（秒级时间戳）'),
        limit: z.number().int().min(1).max(SAMPLE_LIMIT_MAX).optional().describe('样本条数，缺省 10'),
      }).optional().describe('样本过滤面（传了 sampleIds 时忽略）'),
      sampleIds: z.array(z.string()).min(1).max(SAMPLE_LIMIT_MAX).optional()
        .describe('复测锚点：sample_category_records 给出的 subjectId，按顺序逐条精确加载，不重新随机、不套 filter'),
    },
    role: 'admin',
    write: true,
    handler: async (deps, args) => {
      const dep = deps.categoryTest;
      if (!dep) throw new HttpError(400, '分类试跑未装配');
      return runCategoryTest({ ...dep, db: deps.db }, args);
    },
  },
];

// ---- gateway 专属（渠道推送规则自助；渠道只由令牌绑定的调用域确定，不信任任何调用方声明的身份）----

const gatewayTools: McpToolDef[] = [
  {
    name: 'list_group_channels',
    description: '本渠道（令牌绑定的 QQ 群/私聊）信息：id / 名称 / targetType / 群号或 QQ 号。'
      + '只回本渠道一条——别的渠道不在本渠道的可见范围内',
    schema: {},
    role: 'gateway',
    handler: (deps, _args, ctx) => {
      const channelId = requireScopeChannel(ctx);
      const c = deps.db.listPushChannels().find((x) => x.id === channelId);
      if (!c || !isSelfServiceChannel(c)) return []; // 令牌绑的渠道不可自助（toast/停用/已删）→ 空列表
      return [{ id: c.id, name: c.name, targetType: c.targetType, groupId: c.targetId }];
    },
  },
  {
    name: 'add_group_push_rule',
    description: `往**本渠道**（令牌绑定的 QQ 群/私聊，渠道不需要也不接受传参）添加主播开播推送规则。`
      + `限制：主播必须已在监听名单（否则先让主人在面板添加）；本渠道自助规则最多 ${MAX_MCP_RULES_PER_CHANNEL} 条；同主播同分类去重`,
    // 身份字段不进 schema：渠道由 ctx.scope.channelId 注入（LLM 填了也会被 zod 剥离）
    schema: {
      uid: uidSchema.describe('主播 uid（先 search_streamers 确认）'),
      categoryId: idSchema.nullable().optional().describe('分类 id（list_categories 获取）；null/不传 = 任意开播都推'),
      messageTemplate: z.string().optional().describe('推送词覆盖，{liver}/{uname}/{title} 占位；不传 = 内置默认'),
      name: z.string().optional().describe('规则名（不传自动命名）'),
    },
    role: 'gateway',
    write: true,
    handler: (deps, args, ctx) => {
      const channelId = requireScopeChannel(ctx);
      if (!mcpWriteLimiter.allow(writeLimitBucket(ctx))) throw new HttpError(429, '操作太频繁，请稍后再试');
      selfServiceChannel(deps, channelId);
      const uid = args.uid as string;
      if (!deps.db.getStreamer(uid)) {
        throw new HttpError(400, '该主播不在监听名单（想监听新主播请联系主人在面板添加）');
      }
      const categoryId = (args.categoryId as number | null | undefined) ?? null;
      checkRuleRefs(deps.db, { subjectKind: 'live', categoryId, scope: [uid], channels: [channelId] });
      const mine = deps.db.listPushRules()
        .filter((r) => r.createdBy === 'mcp' && r.channels.includes(channelId));
      if (mine.length >= MAX_MCP_RULES_PER_CHANNEL) {
        throw new HttpError(400, `本渠道的自助规则已达上限（${MAX_MCP_RULES_PER_CHANNEL} 条），请先删除不需要的`);
      }
      const dup = mine.find((r) => r.subjectKind === 'live' && r.scope.includes(uid) && r.categoryId === categoryId);
      if (dup) throw new HttpError(409, `已有相同规则：#${dup.id} ${dup.name}`);
      const id = deps.db.upsertPushRule({
        name: typeof args.name === 'string' ? args.name.trim() : '',
        subjectKind: 'live',
        categoryId,
        scope: [uid],
        channels: [channelId],
        messageTemplate: typeof args.messageTemplate === 'string' && args.messageTemplate !== ''
          ? args.messageTemplate : null,
        enabled: true,
        createdBy: 'mcp',
      });
      return { ok: true, id };
    },
  },
  {
    name: 'remove_group_push_rule',
    description: '让本渠道不再收到某条推送规则（只处理令牌绑定的渠道，id 从 list_push_rules 取）：'
      + '自助规则整条删除；主人配置的规则不整条删——只把本渠道移出'
      + '（它还推别的渠道时其余渠道原样保留；唯一渠道就是本渠道时渠道置空、规则行与内容全留）',
    schema: { id: idSchema.describe('规则 id（list_push_rules 获取）') },
    role: 'gateway',
    write: true,
    handler: (deps, args, ctx) => {
      const channelId = requireScopeChannel(ctx);
      if (!mcpWriteLimiter.allow(writeLimitBucket(ctx))) throw new HttpError(429, '操作太频繁，请稍后再试');
      const id = args.id as number;
      const rule = deps.db.listPushRules().find((r) => r.id === id);
      if (!rule) throw new HttpError(404, '规则不存在');
      // 渠道归属校验（不再只认 createdBy）：不推本渠道的规则，本渠道碰不到
      if (!rule.channels.includes(channelId)) {
        throw new HttpError(403, `规则 #${id} 不推送本渠道，本渠道无权改动（只能动 list_push_rules 里列出的规则）`);
      }
      const selfCreated = rule.createdBy === 'mcp';
      // copy-on-write（plan「多渠道规则」）：多渠道规则先拆出只含本渠道的一条（createdBy='mcp'），
      // 后续写只操作这条——原规则保留其余渠道、内容一行不动；单渠道就是就地操作。
      // 拆分与后续写同一个事务：不留半成品，也不存在「拆了却没删」的中间态。
      let split = false;
      const ruleRemoved = deps.db.transaction(() => {
        if (!selfCreated && rule.channels.length === 1) {
          // 非 mcp 规则只允许**渠道级操作**（不得整条删除）：本渠道是它唯一渠道时，
          // 移出 = channels 置空——行与内容全留（主人在面板可见可删），createdBy 原样不动。
          // 这类规则没有「其余的渠道」可保留，因此不拆新行（拆出来也只是随即删掉）。
          deps.db.upsertPushRule({ id, channels: [], createdBy: rule.createdBy });
          return false;
        }
        const target = splitPushRuleChannel(deps.db, rule, channelId);
        split = target.split;
        deps.db.deletePushRule(target.id);
        return target.id === id;
      });
      return { ok: true, id, split, ruleRemoved };
    },
  },
];

export function allToolDefs(): McpToolDef[] {
  return [...sharedTools, ...adminTools, ...gatewayTools];
}

/** 按名取工具定义（REST 收敛后面板路由经它进注册表；找不到 = 装配错误） */
export function toolDefByName(name: string): McpToolDef | undefined {
  return allToolDefs().find((d) => d.name === name);
}

/** 该角色可见的工具（gateway 看不到 admin 工具，反之亦然——不可见即不存在） */
export function toolDefsForRole(role: McpAuth['role']): McpToolDef[] {
  return allToolDefs().filter((t) => t.role === 'shared' || t.role === role);
}

/** 按角色把工具注册进 SDK server（每请求一个新 server 实例，无状态模式）。
 *  执行统一走 runTool（能力层唯一执行入口：zod 再校验 + 审计 + 错误归一）；
 *  text 映射保持与改造前逐字一致（契约见 run-tool.ts 头注释）。 */
export function registerTools(server: McpServer, deps: PanelDeps, ctx: McpAuth): void {
  for (const def of toolDefsForRole(ctx.role)) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.schema },
      // args 已由 SDK 按 zod shape 校验过；runToolTracked 内再校验一次（第二个适配器也绕不过），
      // 写操作顺带过 UndoStore 落变更记录（快照方案见 undo.ts track()）
      (async (args: Record<string, unknown>) => {
        const r = await runToolTracked(deps, def, args, ctx, 'mcp');
        return r.ok
          ? { content: [{ type: 'text' as const, text: r.text }] }
          : { content: [{ type: 'text' as const, text: r.text }], isError: true as const };
      }) as never,
    );
  }
}
