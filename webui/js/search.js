// 面板前端 · 设置页「网页搜索」卡：DeepSeek 网页检索与 Apify X 账号搜索凭据。
import { api, toast, ACTIONS, esc, field, openSheet, closeSheet, iconBtn } from './core.js';

let info = null;

function stateText(k, fallback) {
  if (!info) return '加载中…';
  if (k && k.source === 'panel') return '已配置';
  return fallback || '未配置';
}

function keyRow(title, sub, action) {
  return '<div class="row row-2">' +
    `<span class="row-main"><span class="row-line"><span class="row-title">${esc(title)}</span></span>` +
    `<span class="row-sub">${esc(sub)}</span></span>` +
    '<span class="row-end">' + iconBtn(action, 'pencil', '编辑') + '</span></div>';
}

function render() {
  const box = document.getElementById('search-rows');
  if (!box) return;
  const providerName = info && info.providerName ? `复用「${info.providerName}」的 key` : '';
  box.innerHTML = keyRow('DeepSeek API key', stateText(info && info.key, providerName), 'edit-search') +
    keyRow('Apify API token', stateText(info && info.apifyKey), 'edit-apify-search');
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

ACTIONS['edit-apify-search'] = function () {
  const cur = info && info.apifyKey && info.apifyKey.value ? info.apifyKey.value : '';
  openSheet('X 账号搜索', field('Apify API token', '<input id="apify-key" class="inp" value="' + esc(cur) + '">') +
    '<div class="sheet-foot"><button class="btn btn-line" data-action="close-sheet" data-level="1">取消</button>' +
    '<button class="btn btn-primary" data-action="save-apify-key">保存</button></div>');
};

ACTIONS['save-apify-key'] = function () {
  const el = document.getElementById('apify-key');
  api('/api/search/apify-key', 'PUT', { value: el ? el.value.trim() : '' })
    .then(function (j) {
      info = j;
      closeSheet(1);
      render();
      toast('已保存');
    })
    .catch(function (e) { toast(e.message, true); });
};

loadSearch();
