// 面板前端 · 极简 markdown 渲染（Agent 视图助手消息专用，零依赖、无外部解析库）。
// 覆盖 LLM 回复的常见元素：标题 / 段落 / 无序·有序列表 / GFM 管道表格 / 代码块 / 行内码 /
// 粗体 / 链接 / 引用。不支持的一律按原文逐字显示（宁可朴素，绝不渲染错）。
//
// 安全口径：所有输入文本先过 esc()（HTML 转义），产出的标签全部由本文件自己拼；
// 链接只认 http/https 且 target=_blank rel=noopener——不存在 javascript: 或注入 XSS 的路径。
import { esc } from './core.js';

/** 行内元素：`code` / **粗体** / [链接](http...)（输入是未转义原文，函数内先 esc） */
function renderInline(s) {
  let h = esc(s);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  h = h.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return h;
}

/** 表格行 → 单元格数组（剥首尾 |，按 | 切，trim） */
function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map(function (c) { return c.trim(); });
}

/** 表格分隔行（| --- | :---: |）判定 */
function isTableSep(line) {
  const t = line.trim();
  return t.indexOf('-') !== -1 && /^[\s|:=-]+$/.test(t);
}

/** 块级渲染（非代码段）：按行扫描，连续行成组；段落内单换行 = <br> */
function renderBlocks(text) {
  const lines = text.split('\n');
  let html = '';
  let para = [];
  let i = 0;
  function flushPara() {
    if (para.length === 0) return;
    html += '<p>' + para.map(renderInline).join('<br>') + '</p>';
    para = [];
  }
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '') { flushPara(); i++; continue; }
    // 标题 # ~ ####（聊天语境里 # 也很大，一律降两档：# → h3 …… #### → h6）
    const h = /^(#{1,4})\s+(.+)$/.exec(t);
    if (h) {
      flushPara();
      const lvl = h[1].length + 2;
      html += '<h' + lvl + '>' + renderInline(h[2]) + '</h' + lvl + '>';
      i++; continue;
    }
    // GFM 管道表格：当前行带 | 且下一行是分隔行
    if (t.indexOf('|') !== -1 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const head = splitRow(t);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().indexOf('|') !== -1 && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      html += '<table><thead><tr>' + head.map(function (c) { return '<th>' + renderInline(c) + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
        rows.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + renderInline(c) + '</td>'; }).join('') + '</tr>'; }).join('') +
        '</tbody></table>';
      continue;
    }
    // 引用块
    if (t.startsWith('>')) {
      flushPara();
      const qs = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        qs.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      html += '<blockquote>' + qs.map(renderInline).join('<br>') + '</blockquote>';
      continue;
    }
    // 无序列表
    if (/^[-*]\s+/.test(t)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i++;
      }
      html += '<ul>' + items.map(function (x) { return '<li>' + renderInline(x) + '</li>'; }).join('') + '</ul>';
      continue;
    }
    // 有序列表
    if (/^\d{1,2}[.)]\s+/.test(t)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\d{1,2}[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d{1,2}[.)]\s+/, ''));
        i++;
      }
      html += '<ol>' + items.map(function (x) { return '<li>' + renderInline(x) + '</li>'; }).join('') + '</ol>';
      continue;
    }
    para.push(t);
    i++;
  }
  flushPara();
  return html;
}

/** markdown → HTML。``` 代码围栏先切段（奇数段 = 代码，首行是语言标注直接丢），其余走块级 */
export function renderMd(src) {
  const chunks = String(src == null ? '' : src).split('```');
  let html = '';
  for (let i = 0; i < chunks.length; i++) {
    if (i % 2 === 1) {
      // 未闭合的围栏：最后一段也按代码收（宽容渲染，内容不丢）
      const code = chunks[i].replace(/^[^\n]*(\n|$)/, '').replace(/\n$/, '');
      html += '<pre><code>' + esc(code) + '</code></pre>';
    } else {
      html += renderBlocks(chunks[i]);
    }
  }
  return html;
}
