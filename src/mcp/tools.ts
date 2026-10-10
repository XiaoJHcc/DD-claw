/**
 * MCP 工具注册表（能力层）：面板 REST 之外的第二适配面，handler 全部复用面板同款
 * Db 方法 / http-util 校验函数 / deps 热生效回调——写路径与面板语义完全一致。
 *
 * 权限模型（详见 auth.ts 头注释）：工具参数不可信（LLM 生成，可被 prompt injection 伪造），
 * 可信的只有连接级 token 角色。因此 admin 工具在 gateway 连接上根本不注册（tools/list
 * 不可见），而不是注册后拒绝。gateway 唯一可写的是「群推送规则自助」，服务端强制：
 * 只能选已启用的 QQ 群渠道、主播必须在监听名单、规则打 createdBy='mcp' 标记、
 * 只能删同标记规则、单渠道 ≤ 20 条、写操作限流。
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { makeLogger } from '../logger.js';
import type { PanelDeps } from '../panel/server.js';
import {
  HttpError, checkAccountRuleIds, checkCategoryConditions, checkChannelShape, checkPostFiltersUsable,
  checkPostJudgeUsable,
  checkPostRuleRefs, checkRuleRefs, deletePostRuleSweepingRefs, parseBiliAccountPatch,
  parseCategoryPatch, parseChannelPatch,
  parseNewBiliAccount, parseNewCategory, parseNewChannel, parseNewPostRule, parseNewRule, parseNewWeiboAccount,
  parseNewXAccount,
  parsePostRulePatch, parseRulePatch, parseRuntimePatch, parseStreamerPatch, parseWeiboAccountPatch,
  parseXAccountPatch, parseXPatch, syncStreamerWeiboLink, watchStreamer,
} from '../panel/http-util.js';
import { scheduleInfo } from '../panel/schedule.js';
import { setPushEnabled } from '../core/push.js';
import { normalizeCsvText, splitCsvText } from '../core/csv.js';
import { setListen, listenReadyFor, listenSetting, type ListenFeature } from '../core/listen.js';
import { X_INTERVAL_MAX, X_INTERVAL_MIN } from '../core/x-config.js';
import { getRuntimeConfig, saveRuntimeConfig, NUM_SPECS, BOOL_SPECS } from '../core/runtime-config.js';
import { isLlmEnabled, setLlmEnabled } from '../analysis/providers.js';
import { llmProviderSchema } from '../config/schema.js';
import type { StreamerInput } from '../core/streamers.js';
import { mcpWriteLimiter } from './rate-limit.js';
import type { McpAuth } from './auth.js';

const log = makeLogger('mcp');

/** gateway 群自助：单渠道 MCP 规则上限 */
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
  handler: (deps: PanelDeps, args: Record<string, unknown>, ctx: McpAuth) => unknown | Promise<unknown>;
}

const uidSchema = z.string().regex(/^\d+$/, 'uid 必须是纯数字字符串');
const idSchema = z.number().int().positive();

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
    description: '推送规则列表（全局 sort 序）：分类引用（null=任意开播）× 生效主播集合（空=全部）× 渠道 × 推送词覆盖；createdBy=mcp 的是群自助规则',
    schema: {},
    role: 'shared',
    handler: (deps) => deps.db.listPushRules(),
  },
  {
    name: 'list_categories',
    description: '内容分类定义：LLM 提示词 + 关键词/分区确定性条件（condMode 且/或）',
    schema: {},
    role: 'shared',
    handler: (deps) => deps.db.listCategories(),
  },
  {
    name: 'list_channels',
    description: '推送渠道列表：toast=系统通知，onebot=QQ（targetType group/private + targetId 群号/QQ号）',
    schema: {},
    role: 'shared',
    handler: (deps) => deps.db.listPushChannels(),
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
    description: 'X/推特 关注账号名单（独立于 B站主播；含启用状态、最近推文时间、选用的图文帖规则 ruleIds、可选关联主播）',
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
    description: '微博 关注账号名单（独立于 B站主播；含启用状态、选用的图文帖规则 ruleIds、可选关联主播）',
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
    description: 'B站动态账号名单（账号本身就是主播，uid 即身份锚点；含启用状态、选用的图文帖规则 ruleIds、最近抓取时间）',
    schema: {},
    role: 'shared',
    handler: (deps) => ({ accounts: deps.db.listBiliAccounts() }),
  },
  {
    name: 'list_post_rules',
    description: '图文帖规则列表（平台无关，X / 微博 / B站动态账号共用一张表；规则只定义筛选+渠道+推送词，生效范围在账号侧 ruleIds——见 list_x_accounts / list_weibo_accounts / list_bili_accounts）',
    schema: {},
    role: 'shared',
    handler: (deps) => ({ rules: deps.db.listPostRules() }),
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
    description: '更新监听名单条目：alias 别名 / watch 监听 / weiboNick 微博昵称（自动解析 uid，传 null 清除）/ profileNote 备注。至少传一个字段',
    schema: {
      uid: uidSchema,
      alias: z.string().nullable().optional(),
      watch: z.boolean().optional(),
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
        pickBody(args, ['alias', 'watch', 'weiboNick', 'profileNote']),
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
      ruleIds: z.array(idSchema).optional().describe('选用的图文帖规则 id（规则平台无关，见 list_post_rules）；空 = 这个账号的帖子不推'),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      if (args.id === undefined) {
        const input = parseNewXAccount(pickBody(args, ['screenName', 'displayName', 'biliUid', 'enabled', 'ruleIds']));
        if (args.nickname !== undefined) {
          throw new HttpError(400, '昵称是平台事实（添加校验种入 / 抓取回写），不接受手填');
        }
        if (deps.db.getXAccountByScreenName(input.screenName)) {
          throw new HttpError(409, `@${input.screenName} 已在名单里`);
        }
        checkXBiliUidForMcp(deps, input.biliUid);
        checkAccountRuleIds(deps.db, input.ruleIds);
        const id = deps.db.upsertXAccount(input);
        deps.x?.onChanged();
        return { id, account: deps.db.getXAccount(id) };
      }
      const id = Number(args.id);
      if (!deps.db.getXAccount(id)) throw new HttpError(404, 'X 账号不存在');
      if (args.screenName !== undefined || args.nickname !== undefined) {
        throw new HttpError(400, 'X 的 ID 与昵称是平台事实不可改；要换账号请删除后重新添加');
      }
      const patch = parseXAccountPatch(pickBody(args, ['biliUid', 'displayName', 'enabled', 'ruleIds']));
      if (patch.biliUid !== undefined) checkXBiliUidForMcp(deps, patch.biliUid);
      if (patch.ruleIds !== undefined) checkAccountRuleIds(deps.db, patch.ruleIds);
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
      ruleIds: z.array(idSchema).optional().describe('选用的图文帖规则 id（规则平台无关，见 list_post_rules）；空 = 这个账号的微博不推'),
    },
    role: 'admin',
    write: true,
    handler: async (deps, args) => {
      if (args.id === undefined) {
        const input = parseNewWeiboAccount(pickBody(args, ['uid', 'nickname', 'displayName', 'biliUid', 'enabled', 'ruleIds']));
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
        checkAccountRuleIds(deps.db, input.ruleIds);
        const id = deps.db.upsertWeiboAccount({ ...input, uid });
        deps.weibo?.onChanged();
        return { id, account: deps.db.getWeiboAccount(id) };
      }
      const id = Number(args.id);
      if (!deps.db.getWeiboAccount(id)) throw new HttpError(404, '微博账号不存在');
      if (args.uid !== undefined || args.nickname !== undefined) {
        throw new HttpError(400, '微博 uid 与昵称是平台事实不可改（抓取会回写）；要换账号请删除后重新添加');
      }
      const patch = parseWeiboAccountPatch(pickBody(args, ['displayName', 'biliUid', 'enabled', 'ruleIds']));
      if (patch.biliUid !== undefined) checkWeiboBiliUidForMcp(deps, patch.biliUid);
      if (patch.ruleIds !== undefined) checkAccountRuleIds(deps.db, patch.ruleIds);
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
      ruleIds: z.array(idSchema).optional().describe('选用的图文帖规则 id（规则平台无关，见 list_post_rules）；空 = 这个账号的动态不推'),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      if (args.uname !== undefined) {
        throw new HttpError(400, 'B站用户名是平台事实（抓取回写），不接受手填');
      }
      if (args.id === undefined) {
        const input = parseNewBiliAccount(pickBody(args, ['uid', 'displayName', 'enabled', 'ruleIds']));
        if (deps.db.getBiliAccountByUid(input.uid)) throw new HttpError(409, `uid ${input.uid} 已在名单里`);
        checkAccountRuleIds(deps.db, input.ruleIds);
        const id = deps.db.upsertBiliAccount(input);
        return { id, account: deps.db.getBiliAccount(id) };
      }
      const id = Number(args.id);
      if (!deps.db.getBiliAccount(id)) throw new HttpError(404, 'B站动态账号不存在');
      if (args.uid !== undefined) {
        throw new HttpError(400, 'uid 是身份锚点不可改；要换账号请删除后重新添加');
      }
      const patch = parseBiliAccountPatch(pickBody(args, ['displayName', 'enabled', 'ruleIds']));
      if (patch.ruleIds !== undefined) checkAccountRuleIds(deps.db, patch.ruleIds);
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
    name: 'upsert_post_rule',
    description: '新建/更新图文帖规则（平台无关：X / 微博 / B站动态账号都可选 → 渠道推送）。带 id = 更新（未提供字段保留原值），不带 = 新建；'
      + '规则只定义筛选+渠道+推送词，生效范围在账号侧（用 upsert_x_account / upsert_weibo_account / upsert_bili_account 的 ruleIds 选用）；'
      + '「原创」「转发」至少要勾一个',
    schema: {
      id: idSchema.optional(),
      name: z.string().optional(),
      channels: z.array(idSchema).optional().describe('推送渠道 id（与开播规则共用 push_channels）'),
      filters: z.object({
        original: z.boolean().optional().describe('原创'),
        retweet: z.boolean().optional().describe('转发'),
        quote: z.boolean().optional().describe('引用（只有 X 帖能标引用；勾上对非 X 帖永不命中，是语义不是错误）'),
        media: z.boolean().optional().describe('必须带图'),
        keywords: z.array(z.string()).optional().describe('正文关键词，命中任一即可'),
      }).optional(),
      messageTemplate: z.string().nullable().optional().describe('推送词，可用 {author} {text} {url} {liver}'),
      llmJudge: z.boolean().optional().describe('交给 LLM 判定「要不要推」（须同时给 judgePrompt）'),
      judgePrompt: z.string().nullable().optional().describe('判定标准（人填口径）；llmJudge=true 时必填'),
      llmTranslate: z.boolean().optional().describe('推送时附上 LLM 译文（运行时只对 X 帖生效，微博/B站本就中文不译）'),
      enabled: z.boolean().optional(),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const keys = [
        'name', 'channels', 'filters', 'messageTemplate',
        'llmJudge', 'judgePrompt', 'llmTranslate', 'enabled',
      ] as const;
      if (args.id === undefined) {
        const rule = parseNewPostRule(pickBody(args, keys));
        checkPostRuleRefs(deps.db, rule);
        return { id: deps.db.upsertPostRule(rule) };
      }
      const id = Number(args.id);
      const prev = deps.db.listPostRules().find((r) => r.id === id);
      if (!prev) throw new HttpError(404, '图文帖规则不存在');
      const patch = parsePostRulePatch(pickBody(args, keys));
      checkPostRuleRefs(deps.db, { channels: patch.channels ?? prev.channels });
      checkPostFiltersUsable({ ...prev.filters, ...(patch.filters ?? {}) });
      checkPostJudgeUsable(
        patch.llmJudge ?? prev.llmJudge,
        patch.judgePrompt !== undefined ? patch.judgePrompt : prev.judgePrompt,
      );
      deps.db.upsertPostRule({ id, ...patch });
      return { id };
    },
  },
  {
    name: 'delete_post_rule',
    description: '删除图文帖规则（连带清扫三份账号名单里选用了它的 ruleIds）',
    schema: { id: idSchema },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      if (!deletePostRuleSweepingRefs(deps.db, Number(args.id))) throw new HttpError(404, '图文帖规则不存在');
      return { ok: true };
    },
  },
  {
    name: 'upsert_category',
    description: '新建/更新内容分类（LLM 提示词 + 关键词/分区条件，三者至少一项非空）。带 id = 更新（未传字段保留原值），不带 = 新建',
    schema: {
      id: idSchema.optional(),
      name: z.string().optional(),
      llmPrompt: z.string().nullable().optional().describe('LLM 判定提示词；null/空串 = 纯确定性分类'),
      keywords: z.array(z.string()).optional(),
      areas: z.array(z.string()).optional(),
      condMode: z.enum(['and', 'or']).optional(),
      enabled: z.boolean().optional(),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const keys = ['name', 'llmPrompt', 'keywords', 'areas', 'condMode', 'enabled'] as const;
      if (args.id === undefined) {
        const c = parseNewCategory(pickBody(args, keys));
        return { id: deps.db.upsertCategory(c) };
      }
      const id = args.id as number;
      const prev = deps.db.listCategories().find((c) => c.id === id);
      if (!prev) throw new HttpError(404, '分类不存在');
      const patch = parseCategoryPatch(pickBody(args, keys));
      // 条件校验对合并后的形状做（同面板 PUT）
      checkCategoryConditions({
        llmPrompt: patch.llmPrompt !== undefined ? patch.llmPrompt : prev.llmPrompt,
        keywords: patch.keywords ?? prev.keywords,
        areas: patch.areas ?? prev.areas,
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
      const disabledRules = deps.db.disablePushRulesByCategory(id);
      deps.db.deleteCategory(id);
      return { ok: true, disabledRules };
    },
  },
  {
    name: 'upsert_push_rule',
    description: '新建/更新推送规则（分类引用 null=任意开播 × uids 空=全部主播 × 渠道 × 推送词覆盖）。带 id = 更新，不带 = 新建。分类/渠道/主播引用必须存在',
    schema: {
      id: idSchema.optional(),
      name: z.string().optional(),
      categoryId: idSchema.nullable().optional(),
      uids: z.array(uidSchema).optional().describe('生效主播 uid 集合；空数组 = 全部主播'),
      channels: z.array(idSchema).optional(),
      messageTemplate: z.string().nullable().optional().describe('推送词，{liver}/{uname}/{title} 占位；null = 内置默认'),
      enabled: z.boolean().optional(),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const keys = ['name', 'categoryId', 'uids', 'channels', 'messageTemplate', 'enabled'] as const;
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
        categoryId: patch.categoryId !== undefined ? patch.categoryId : prev.categoryId,
        uids: patch.uids ?? prev.uids,
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
        keyCount: splitCsvText(deps.db.getSetting(`llm_key:${p.name}`)).length,
      })),
    }),
  },
  {
    name: 'upsert_llm_provider',
    description: '新增/更新 LLM provider（按 name 定位，name 不可改）。新建需 name+baseURL+model；可顺带传 key。保存后路由热重建',
    schema: {
      name: z.string().min(1),
      baseURL: z.string().optional(),
      model: z.string().optional(),
      vision: z.boolean().optional(),
      enabled: z.boolean().optional(),
      structuredOutput: z.enum(['schema', 'object', 'none']).optional(),
      api: z.enum(['chat-completions', 'responses']).optional(),
      key: z.string().optional().describe('API key（多个用逗号分隔，中英文逗号均可）；空串 = 清除'),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const store = deps.llm?.store;
      if (!store) throw new HttpError(400, 'LLM provider 管理未装配');
      const list = store.list();
      const prev = list.find((p) => p.name === (args.name as string));
      const patch = pickBody(args, ['baseURL', 'model', 'vision', 'enabled', 'structuredOutput', 'api']);
      const merged = prev ? { ...prev, ...patch } : { name: args.name, ...patch };
      const parsed = llmProviderSchema.safeParse(merged);
      if (!parsed.success) {
        const msg = parsed.error.issues
          .map((i) => `${i.path.length ? i.path.join('.') : '(根)'}: ${i.message}`).join('；');
        throw new HttpError(400, `provider 校验失败：${msg}`);
      }
      const provider = parsed.data;
      store.save(prev
        ? list.map((p) => (p.name === provider.name ? provider : p))
        : [...list, provider]);
      // key 可随表单一并提交（同面板弹窗体验）；空串 = 清除；中文逗号归一成英文逗号落库
      if (typeof args.key === 'string') {
        deps.db.setSetting(`llm_key:${provider.name}`, normalizeCsvText(args.key.trim()));
        deps.llm?.router?.refreshKeys();
      }
      deps.llm?.onProvidersChanged?.();
      return { ok: true, name: provider.name };
    },
  },
  {
    name: 'delete_llm_provider',
    description: '删除 LLM provider（不动已存的 key 设置项）',
    schema: { name: z.string().min(1) },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const store = deps.llm?.store;
      if (!store) throw new HttpError(400, 'LLM provider 管理未装配');
      const list = store.list();
      if (!list.some((p) => p.name === args.name)) throw new HttpError(404, 'provider 不存在');
      store.save(list.filter((p) => p.name !== args.name));
      deps.llm?.onProvidersChanged?.();
      return { ok: true };
    },
  },
  {
    name: 'set_llm_key',
    description: '设置/清除某 provider 的 API key（多个用逗号分隔，中英文逗号均可；空串 = 清除）。保存即热更新',
    schema: {
      name: z.string().min(1),
      value: z.string().describe('key 值；空串 = 清除'),
    },
    role: 'admin',
    write: true,
    handler: (deps, args) => {
      const name = args.name as string;
      const value = normalizeCsvText((args.value as string).trim());
      const list = deps.llm?.store?.list() ?? [];
      if (!list.some((p) => p.name === name)) throw new HttpError(404, `provider 不存在: ${name}`);
      if (value && !/^[^\s,]+(\s*,\s*[^\s,]+)*$/.test(value)) {
        throw new HttpError(400, '多个 key 用逗号分隔（中英文逗号均可），key 内不能有空格');
      }
      deps.db.setSetting(`llm_key:${name}`, value);
      deps.llm?.router?.refreshKeys();
      return { ok: true, provider: name };
    },
  },
];

// ---- gateway 专属（群推送规则自助；服务端强制收敛，不信任任何调用方声明的群号/身份）----

const gatewayTools: McpToolDef[] = [
  {
    name: 'list_group_channels',
    description: '可自助配置的 QQ 群渠道列表（已启用的 onebot 群渠道）',
    schema: {},
    role: 'gateway',
    handler: (deps) =>
      deps.db.listPushChannels()
        .filter((c) => c.notifier === 'onebot' && c.targetType === 'group' && c.enabled)
        .map((c) => ({ id: c.id, name: c.name, groupId: c.targetId })),
  },
  {
    name: 'add_group_push_rule',
    description: `往某个 QQ 群渠道添加主播开播推送规则。限制：主播必须已在监听名单（否则先让主人在面板添加）；单群最多 ${MAX_MCP_RULES_PER_CHANNEL} 条自助规则；同主播同分类去重`,
    schema: {
      channelId: idSchema.describe('群渠道 id（先 list_group_channels 获取）'),
      uid: uidSchema.describe('主播 uid（先 search_streamers 确认）'),
      categoryId: idSchema.nullable().optional().describe('分类 id（list_categories 获取）；null/不传 = 任意开播都推'),
      messageTemplate: z.string().optional().describe('推送词覆盖，{liver}/{uname}/{title} 占位；不传 = 内置默认'),
      name: z.string().optional().describe('规则名（不传自动命名）'),
    },
    role: 'gateway',
    write: true,
    handler: (deps, args, ctx) => {
      if (!mcpWriteLimiter.allow(ctx.name)) throw new HttpError(429, '操作太频繁，请稍后再试');
      const channelId = args.channelId as number;
      const ch = deps.db.listPushChannels().find((c) => c.id === channelId);
      if (!ch || ch.notifier !== 'onebot' || ch.targetType !== 'group' || !ch.enabled) {
        throw new HttpError(400, '只能往已启用的 QQ 群渠道添加规则（先 list_group_channels 看可选渠道）');
      }
      const uid = args.uid as string;
      if (!deps.db.getStreamer(uid)) {
        throw new HttpError(400, '该主播不在监听名单（想监听新主播请联系主人在面板添加）');
      }
      const categoryId = (args.categoryId as number | null | undefined) ?? null;
      if (categoryId !== null && !deps.db.listCategories().some((c) => c.id === categoryId)) {
        throw new HttpError(400, '分类不存在');
      }
      const mine = deps.db.listPushRules()
        .filter((r) => r.createdBy === 'mcp' && r.channels.includes(channelId));
      if (mine.length >= MAX_MCP_RULES_PER_CHANNEL) {
        throw new HttpError(400, `该群的自助规则已达上限（${MAX_MCP_RULES_PER_CHANNEL} 条），请先删除不需要的`);
      }
      const dup = mine.find((r) => r.uids.includes(uid) && r.categoryId === categoryId);
      if (dup) throw new HttpError(409, `已有相同规则：#${dup.id} ${dup.name}`);
      const id = deps.db.upsertPushRule({
        name: typeof args.name === 'string' ? args.name.trim() : '',
        categoryId,
        uids: [uid],
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
    description: '删除群自助推送规则（只能删 add_group_push_rule 创建的规则，面板创建的规则动不了）',
    schema: { id: idSchema.describe('规则 id（list_push_rules 获取）') },
    role: 'gateway',
    write: true,
    handler: (deps, args, ctx) => {
      if (!mcpWriteLimiter.allow(ctx.name)) throw new HttpError(429, '操作太频繁，请稍后再试');
      const id = args.id as number;
      const rule = deps.db.listPushRules().find((r) => r.id === id);
      if (!rule) throw new HttpError(404, '规则不存在');
      if (rule.createdBy !== 'mcp') {
        throw new HttpError(403, '只能删除群自助创建的规则（createdBy=mcp），面板规则请联系主人');
      }
      deps.db.deletePushRule(id);
      return { ok: true };
    },
  },
];

export function allToolDefs(): McpToolDef[] {
  return [...sharedTools, ...adminTools, ...gatewayTools];
}

/** 该角色可见的工具（gateway 看不到 admin 工具，反之亦然——不可见即不存在） */
export function toolDefsForRole(role: McpAuth['role']): McpToolDef[] {
  return allToolDefs().filter((t) => t.role === 'shared' || t.role === role);
}

/** 审计日志：写操作落日志（角色 + 工具 + 参数摘要；llm key 值打码） */
function auditLog(ctx: McpAuth, tool: string, args: Record<string, unknown>): void {
  const sanitized = { ...args };
  if (tool === 'set_llm_key' && 'value' in sanitized) sanitized.value = '***';
  if ('key' in sanitized) sanitized.key = '***';
  log.info(`MCP 写操作 [${ctx.role}:${ctx.name}] ${tool} ${JSON.stringify(sanitized)}`);
}

/** 按角色把工具注册进 SDK server（每请求一个新 server 实例，无状态模式） */
export function registerTools(server: McpServer, deps: PanelDeps, ctx: McpAuth): void {
  for (const def of toolDefsForRole(ctx.role)) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.schema },
      // args 已由 SDK 按 zod shape 校验过，handler 内部按 Record 取用
      (async (args: Record<string, unknown>) => {
        try {
          if (def.write) auditLog(ctx, def.name, args);
          const result = await def.handler(deps, args, ctx);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? { ok: true }, null, 2) }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { content: [{ type: 'text' as const, text: `错误：${msg}` }], isError: true as const };
        }
      }) as never,
    );
  }
}
