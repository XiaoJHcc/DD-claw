// 面板前端 · 设置页「网页搜索」卡（= agent 联网检索的 key）。
// 只有一把 key：search_key（settings），缺省回退到 DeepSeek 供应商的 key——所以卡片副行
// 要如实说明当前来源；编辑收进二级弹窗（与 LLM key 同形态：本机明文回显）。
import { api, toast, ACTIONS, esc, field, openSheet, closeSheet, iconBtn } from './core.js';

let info = null;

function deepseekName() {
  return info && info.providerName ? info.providerName : '';
}

function stateText() {
  if (!info) return '加载中…';
  const k = info.key || {};
  if (k.source === 'panel') return k.count > 1 ? `已配置（${k.count} 个 key）` : '已配置';
  const name = deepseekName();
  return name ? `复用「${name}」的 key` : '未配置';
}

function render() {
  const box = document.getElementById('search-rows');
  if (!box) return;
  box.innerHTML = '<div class="row row-2">' +
    '<span class="row-main"><span class="row-line"><span class="row-title">DeepSeek API key</span></span>' +
    `<span class="row-sub">${esc(stateText())}</span></span>` +
    '<span class="row-end">' + iconBtn('edit-search', 'pencil', '编辑') + '</span></div>';
}

function loadSearch() {
  return api('/api/search').then(function (j) {
    info = j;
    render();
  }).catch(function (e) { toast(e.message, true); });
}

ACTIONS['edit-search'] = function () {
  const cur = info && info.key && info.key.value ? info.key.value : '';
  openSheet('网页搜索', field('DeepSeek API key', '<input id="search-key" class="inp" placeholder="如 sk-xxx" value="' +
    esc(cur) + '">') +
    '<div class="sheet-foot"><button class="btn btn-line" data-action="close-sheet" data-level="1">取消</button>' +
    '<button class="btn btn-primary" data-action="save-search-key">保存</button></div>');
};

ACTIONS['save-search-key'] = function () {
  const el = document.getElementById('search-key');
  api('/api/search/key', 'PUT', { value: el ? el.value.trim() : '' })
    .then(function (j) {
      info = j;
      closeSheet(1);
      render();
      toast('已保存');
    })
    .catch(function (e) { toast(e.message, true); });
};

loadSearch();
