// 面板前端 · 图标渲染：消费 lucide 图标数据（./lucide-icons.js，isc 协议节选 v1.33.0），
// 按 lucide 官方节点格式 [tag, {attr}] 生成内联 SVG。无外部图标库，离线可用。
// 样式沿旧内联集：24 viewBox、stroke=currentColor、fill none、round caps/joins；
// stroke-width 取 lucide 官方默认 2（原手绘集是 1.8，差异在可接受范围）。
import { LUCIDE } from './lucide-icons.js';

/** 节点 → SVG 内部片段（lucide 官方 createElement 的语义简化版：属性值直接拼） */
function nodeHtml(node) {
  var tag = node[0];
  var attrs = node[1];
  var html = '<' + tag;
  for (var k in attrs) html += ' ' + k + '="' + attrs[k] + '"';
  return html + '/>';
}

export function icon(name) {
  var nodes = LUCIDE[name];
  if (!nodes) return '';
  var inner = '';
  for (var i = 0; i < nodes.length; i++) inner += nodeHtml(nodes[i]);
  return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    inner + '</svg>';
}
