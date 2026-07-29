import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffRoom, type PrevState } from './state.js';
import type { RoomStatus } from '../sources/bili/types.js';

const OPTS = { notifyOnColdStart: false, now: 1_800_000_000 };
const UID = '7706705';

function status(over: Partial<RoomStatus> = {}): RoomStatus {
  return {
    uid: UID, roomId: '80397', uname: '阿梓从小就很可爱',
    title: '孩子们下午好', isLive: true, rawLiveStatus: 1, liveTime: 1_785_310_737,
    areaName: '无畏契约', parentAreaName: '网游', cover: '', keyframe: 'k.jpg',
    ...over,
  };
}

function prev(over: Partial<PrevState> = {}): PrevState {
  return { roomId: '80397', isLive: true, liveTime: 1_785_310_737, title: '孩子们下午好', ...over };
}

test('0 → 1 产出 live_start', () => {
  const s = diffRoom(UID, prev({ isLive: false, liveTime: 0 }), status(), OPTS);
  assert.deepEqual(s.map((x) => x.kind), ['live_start']);
});

test('1 → 1 且 liveTime 不变，无 Signal', () => {
  assert.deepEqual(diffRoom(UID, prev(), status(), OPTS), []);
});

test('1 → 1 但 liveTime 变了，产出 live_end + live_start', () => {
  const s = diffRoom(UID, prev(), status({ liveTime: 1_785_400_000 }), OPTS);
  assert.deepEqual(s.map((x) => x.kind), ['live_end', 'live_start']);
});

test('同一场内标题变更产出 title_change 并带上旧标题', () => {
  const s = diffRoom(UID, prev(), status({ title: '开始唱歌了' }), OPTS);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.kind, 'title_change');
  assert.equal(s[0]!.previousTitle, '孩子们下午好');
});

test('1 → 0 产出 live_end', () => {
  const s = diffRoom(UID, prev(), status({ isLive: false, rawLiveStatus: 0, liveTime: 0 }), OPTS);
  assert.deepEqual(s.map((x) => x.kind), ['live_end']);
});

test('轮播(live_status=2) 视为未开播，产出 live_end', () => {
  const s = diffRoom(UID, prev(), status({ isLive: false, rawLiveStatus: 2, liveTime: 0 }), OPTS);
  assert.deepEqual(s.map((x) => x.kind), ['live_end']);
});

test('curr 为 null（返回里缺该 uid）时按未开播处理', () => {
  assert.deepEqual(diffRoom(UID, prev(), null, OPTS).map((x) => x.kind), ['live_end']);
  assert.deepEqual(diffRoom(UID, prev({ isLive: false }), null, OPTS), []);
});

test('curr 为 null 时合成的 status 仍带正确 uid（多主播下不能串）', () => {
  const s = diffRoom('999', prev(), null, OPTS);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.uid, '999');
  assert.equal(s[0]!.status.uid, '999', 'signal 必须能自证属于哪个主播');
});

test('无 prev 且 notifyOnColdStart=false 时不推', () => {
  assert.deepEqual(diffRoom(UID, undefined, status(), OPTS), []);
});

test('无 prev 且 notifyOnColdStart=true 时推送', () => {
  const s = diffRoom(UID, undefined, status(), { ...OPTS, notifyOnColdStart: true });
  assert.deepEqual(s.map((x) => x.kind), ['live_start']);
});

test('无 prev 且未开播，任何配置下都无 Signal', () => {
  const off = status({ isLive: false, liveTime: 0 });
  assert.deepEqual(diffRoom(UID, undefined, off, { ...OPTS, notifyOnColdStart: true }), []);
});
