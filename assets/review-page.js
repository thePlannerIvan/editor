(function () {
  'use strict';

  var DATA = window.DATA;
  var ITEMS = DATA.items;
  var BLOCKS = DATA.blocks;
  var ORDER = DATA.order;
  var LAYER_NAME = { l1: 'L1 机械性', l2: 'L2 语法表达', l3: 'L3 事实存疑' };
  var LAYER_DESC = { l1: '错别字 · 标点 · 的地得', l2: '语法 · 搭配 · 语序', l3: '事实 · 引文 · 专名' };
  var STORE_KEY = 'editor-proofread:' + DATA.dataVersion;

  var state = {
    manualBlocks: new Set(),
    undoStack: [],
    resolutions: {},
    filter: 'all',
    activeItem: null,
    dirty: false,
    restored: false,
    bridgeReady: false,
    draftSavedAt: '',
  };
  var review = null;
  var draftTimer = null;
  var statusTimer = null;
  var toastTimer = null;
  var booted = false;

  function $(id) { return document.getElementById(id); }
  function docNode() { return $('doc'); }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  }
  function truncate(value, size) {
    var text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > size ? text.slice(0, size) + '…' : text;
  }
  function itemOf(id) { return ITEMS[id] || null; }

  function itemTitle(item) {
    var extra = item.layer === 'l3'
      ? (item.reason || '') + (item.direction ? ' 查证：' + item.direction : '')
      : (item.note || '');
    return (item.tag || '') + (extra ? ' · ' + extra : '');
  }

  function tokenHtml(kind, id, text) {
    var item = itemOf(id);
    var label = item ? itemTitle(item) : '';
    var prefix = kind === 'del' ? '修改前 · 点一下＝不改（保留原文）；⌥ 反向' : kind === 'ins' ? '修改后 · 点一下＝同意修改；⌥ 反向' : '点一下标记要查证';
    return '<span class="ai-' + kind + '" data-ai-id="' + esc(id) + '" data-kind="' + kind
      + '" contenteditable="false" role="button" tabindex="0" autocomplete="off"'
      + ' title="' + esc(prefix + (label ? ' · ' + label : '')) + '">' + esc(text) + '</span>';
  }

  function runsHtml(block) {
    var html = '';
    (block.runs || []).forEach(function (run) {
      if (run.i) { html += tokenHtml('ins', run.i, run.t); return; }
      if (run.d) { html += tokenHtml('del', run.d, run.t); return; }
      var text = esc(run.t);
      (run.x || []).forEach(function (ctxId) {
        text = '<span class="ai-check" data-ai-id="' + esc(ctxId) + '" data-kind="check"'
          + ' contenteditable="false" role="button" tabindex="0"'
          + ' title="' + esc('点一下标记要查证 · ' + itemTitle(itemOf(ctxId) || {})) + '">' + text + '</span>';
      });
      html += text;
    });
    return html;
  }

  function blockHtml(block) {
    if (block.kind === 'hr') {
      return '<div class="doc-divider" contenteditable="false" data-block-id="' + esc(block.id) + '">◆</div>';
    }
    var tag = /^h[1-6]$/.test(block.kind) ? block.kind : block.kind === 'quote' ? 'blockquote' : block.kind === 'li' ? 'div' : 'p';
    var cls = block.kind === 'li' ? ' class="doc-li"' : '';
    return '<' + tag + cls + ' data-block-id="' + esc(block.id) + '">' + runsHtml(block) + '</' + tag + '>';
  }

  function renderHead() {
    var article = DATA.article;
    $('docTitle').textContent = article.title;
    document.title = '校对工作台 · ' + article.title;
    $('docChip').textContent = '《' + article.title + '》';
    $('docChip').title = article.source || '';
    var filename = String(article.source || '').split('/').pop();
    $('docMeta').textContent = '原文 ' + article.chars.toLocaleString('zh-CN') + ' 字 · '
      + ORDER.length + ' 处 AI 改动 · 来源 ' + filename;
  }

  function renderDoc() {
    docNode().innerHTML = BLOCKS.map(blockHtml).join('');
  }

  /* ------------------------------------------------------------- 状态 */

  function liveSpans(id) {
    return Array.prototype.slice.call(docNode().querySelectorAll('[data-ai-id="' + cssEscape(id) + '"]'));
  }
  function blockOfSpan(span) {
    return span && span.closest ? span.closest('[data-block-id]') : null;
  }
  function itemState(id) {
    var item = itemOf(id);
    if (!item) return 'pending';
    var spans = liveSpans(id);
    if (item.layer === 'l3') {
      if (!spans.length) return 'applied';
      return spans.some(function (span) { return span.getAttribute('data-checked') === '1'; }) ? 'check' : 'pending';
    }
    if (!spans.length) {
      return state.resolutions[id] === 'reject' ? 'rejected' : 'accepted';
    }
    var block = blockOfSpan(spans[0]);
    if (block && state.manualBlocks.has(block.dataset.blockId)) return 'manual';
    return 'pending';
  }
  function stateLabel(id) {
    var item = itemOf(id);
    var value = itemState(id);
    if (value === 'accepted') return '已接受';
    if (value === 'rejected') return '保留原文';
    if (value === 'manual') return '人工';
    if (value === 'check') return '要查证';
    return item && item.layer === 'l3' ? '待标' : '默认接受';
  }
  function appliedIds() {
    return ORDER.filter(function (id) {
      var item = itemOf(id);
      return item && item.layer !== 'l3' && itemState(id) === 'applied';
    });
  }
  function pendingIds() {
    return ORDER.filter(function (id) {
      var item = itemOf(id);
      return item && item.layer !== 'l3' && itemState(id) !== 'applied';
    });
  }
  function checkedL3() {
    return ORDER.filter(function (id) {
      var item = itemOf(id);
      return item && item.layer === 'l3' && itemState(id) === 'check';
    });
  }
  function rejectedIds() {
    return ORDER.filter(function (id) {
      return itemOf(id) && itemOf(id).layer !== 'l3' && itemState(id) === 'rejected';
    });
  }
  function acceptedOrDefault() {
    var rejected = rejectedIds();
    return ORDER.filter(function (id) {
      return itemOf(id).layer !== 'l3' && rejected.indexOf(id) < 0;
    });
  }
  function processedCount() {
    return acceptedOrDefault().length + checkedL3().length;
  }

  /* ------------------------------------------------------------- 清单 / 底栏 */

  function renderRail() {
    var rail = $('rail');
    var scroll = rail.scrollTop;
    var html = '';
    ['l1', 'l2', 'l3'].forEach(function (layer) {
      var ids = ORDER.filter(function (id) {
        if (itemOf(id).layer !== layer) return false;
        if (state.filter !== 'all' && state.filter !== layer) return false;
        return true;
      });
      if (!ids.length) return;
      var groupCount = layer === 'l3'
        ? ids.filter(function (id) { return itemState(id) === 'check'; }).length
        : ids.filter(function (id) { return itemState(id) !== 'rejected'; }).length;
      html += '<div class="rail-group">';
      html += '<div class="rail-group-head"><i class="rail-dot ' + layer + '"></i>'
        + LAYER_NAME[layer] + '<span class="n">' + (layer === 'l3' ? '查证 ' : '接受 ') + groupCount + '/' + ids.length + '</span></div>';
      ids.forEach(function (id) {
        var item = itemOf(id);
        var value = itemState(id);
        var snippet = item.layer === 'l3' ? item.context : item.before;
        var classes = 'rail-row' + (value === 'accepted' || value === 'rejected' ? ' done' : '')
          + (value === 'rejected' ? ' rejected' : '')
          + (state.activeItem === id ? ' active' : '');
        html += '<button class="' + classes + '" data-rail-id="' + esc(id) + '">'
          + '<i class="rail-dot ' + layer + '"></i>'
          + '<span class="rail-main"><span class="rail-tag">' + esc(item.tag) + '</span>'
          + '<span class="rail-snippet">' + esc(truncate(snippet, 34)) + '</span></span>'
          + '<span class="rail-status ' + (value === 'rejected' ? 'rejected' : value === 'accepted' ? 'accepted' : value === 'check' ? 'check' : (layer === 'l3' ? 'pending' : 'default')) + '">'
          + esc(stateLabel(id)) + '</span></button>';
      });
      html += '</div>';
    });
    if (!html) html = '<p class="rail-empty">这一层没有改动。</p>';
    $('railList').innerHTML = html;
    $('railCount').textContent = '接受 ' + acceptedOrDefault().length + '/' + ORDER.filter(function (id) { return itemOf(id).layer !== 'l3'; }).length;
    rail.scrollTop = scroll;
  }

  function renderFooter() {
    var allChanges = ORDER.filter(function (id) { return itemOf(id).layer !== 'l3'; });
    var accepted = acceptedOrDefault().length;
    var rejected = rejectedIds().length;
    var l3Total = ORDER.filter(function (id) { return itemOf(id).layer === 'l3'; }).length;
    var checked = checkedL3().length;
    var manual = state.manualBlocks.size;
    var html = '接受 <b>' + accepted + '/' + allChanges.length + '</b>'
      + '<span class="rejected">保留原文 <b>' + rejected + '</b></span>'
      + '<span class="check">要查证 <b>' + checked + '/' + l3Total + '</b></span>';
    if (manual) html += '<span class="optional">人工 <b>' + manual + '</b> 段</span>';
    $('footStats').innerHTML = html;
  }

  function updateStatusNow() {
    renderRail();
    renderFooter();
  }
  function scheduleStatus() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(updateStatusNow, 120);
  }

  /* ------------------------------------------------------------- 编辑 / 应用 */

  function pushUndo() {
    state.undoStack.push({ html: docNode().innerHTML, manual: Array.from(state.manualBlocks), resolutions: Object.assign({}, state.resolutions) });
    if (state.undoStack.length > 20) state.undoStack.shift();
    updateUndoButton();
  }
  function updateUndoButton() {
    var button = $('undoBtn');
    button.disabled = state.undoStack.length === 0;
    button.title = state.undoStack.length ? '撤销上一步修订（⌘Z）' : '没有可撤销的修订操作';
  }
  function unwrap(node) {
    var parent = node.parentNode;
    while (node.firstChild) parent.insertBefore(node.firstChild, node);
    parent.removeChild(node);
  }
  function removeNodes(nodes) {
    nodes.forEach(function (node) { if (node.parentNode) node.parentNode.removeChild(node); });
  }
  function unwrapNodes(nodes) {
    nodes.slice().forEach(function (node) { if (node.parentNode) unwrap(node); });
  }

  function applyItem(id, mode) {
    var item = itemOf(id);
    if (!item) return;
    if (item.layer === 'l3') { toggleCheck(id); return; }
    var spans = liveSpans(id);
    if (!spans.length) return;
    var dels = spans.filter(function (span) { return span.classList.contains('ai-del'); });
    var inss = spans.filter(function (span) { return span.classList.contains('ai-ins'); });
    pushUndo();
    var caretTarget = mode === 'reject'
      ? (dels.length ? dels[dels.length - 1] : inss[inss.length - 1])
      : (inss.length ? inss[inss.length - 1] : dels[dels.length - 1]);
    var marker = null;
    if (caretTarget && caretTarget.parentNode) {
      marker = document.createElement('span');
      marker.setAttribute('data-caret-marker', '1');
      caretTarget.parentNode.insertBefore(marker, caretTarget.nextSibling);
    }
    if (mode === 'reject') {
      removeNodes(inss);
      unwrapNodes(dels);
      state.resolutions[id] = 'reject';
    } else {
      removeNodes(dels);
      unwrapNodes(inss);
      state.resolutions[id] = 'accept';
    }
    if (marker && marker.parentNode) {
      var caretRange = document.createRange();
      caretRange.setStartBefore(marker);
      caretRange.collapse(true);
      var caretSelection = window.getSelection();
      caretSelection.removeAllRanges();
      caretSelection.addRange(caretRange);
      docNode().focus();
      marker.parentNode.removeChild(marker);
    }
    state.activeItem = id;
    markDirty();
    updateStatusNow();
    toast(mode === 'reject' ? '已改为保留原文，可以直接改' : '已同意这条修改，可以直接改');
  }

  function toggleCheck(id) {
    var spans = liveSpans(id);
    if (!spans.length) return;
    pushUndo();
    var checked = spans.some(function (span) { return span.getAttribute('data-checked') === '1'; });
    spans.forEach(function (span) {
      if (checked) span.removeAttribute('data-checked');
      else span.setAttribute('data-checked', '1');
    });
    state.activeItem = id;
    markDirty();
    updateStatusNow();
    toast(checked ? '已取消查证标记' : '已标记：提交时查证');
  }

  function undo() {
    var snapshot = state.undoStack.pop();
    if (!snapshot) return;
    docNode().innerHTML = snapshot.html;
    state.manualBlocks = new Set(snapshot.manual);
    state.resolutions = Object.assign({}, snapshot.resolutions || {});
    updateUndoButton();
    markDirty();
    updateStatusNow();
    toast('已撤销上一步修订');
  }

  function currentBlockId() {
    var selection = window.getSelection();
    if (selection && selection.rangeCount) {
      var node = selection.anchorNode;
      var element = node && (node.nodeType === 1 ? node : node.parentElement);
      var block = element && element.closest ? element.closest('[data-block-id]') : null;
      if (block) return block.dataset.blockId;
    }
    return null;
  }
  function markManualBlock() {
    var id = currentBlockId();
    if (!id) return;
    var block = docNode().querySelector('[data-block-id="' + cssEscape(id) + '"]');
    if (!block) return;
    if (!state.manualBlocks.has(id)) {
      state.manualBlocks.add(id);
      scheduleStatus();
    }
  }

  /* ------------------------------------------------------------- 定位 */

  function focusItem(id) {
    var item = itemOf(id);
    if (!item) return;
    var span = liveSpans(id)[0];
    var blockId = span ? blockOfSpan(span).dataset.blockId : item.blocks[0];
    var block = blockId ? docNode().querySelector('[data-block-id="' + cssEscape(blockId) + '"]') : null;
    if (!block) return;
    state.activeItem = id;
    renderRail();
    var workspace = $('workspace');
    var workspaceRect = workspace.getBoundingClientRect();
    var blockRect = block.getBoundingClientRect();
    var delta = blockRect.top - (workspaceRect.top + workspaceRect.height * 0.34);
    if (Math.abs(delta) > 8) workspace.scrollTo({ top: workspace.scrollTop + delta, behavior: 'smooth' });
    block.classList.remove('doc-flash');
    void block.offsetWidth;
    block.classList.add('doc-flash');
    setTimeout(function () { block.classList.remove('doc-flash'); }, 1000);
    if (span) {
      liveSpans(id).forEach(function (node) { node.classList.add('is-focus'); });
      setTimeout(function () {
        liveSpans(id).forEach(function (node) { node.classList.remove('is-focus'); });
      }, 1300);
    }
    if (window.innerWidth <= 680) closeRail();
  }

  /* ------------------------------------------------------------- 草稿 / 提示 */

  function toast(text) {
    var node = $('toast');
    node.textContent = text;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove('show'); }, 2600);
  }
  function setNotice(text) {
    var node = $('notice');
    if (!text) { node.hidden = true; node.textContent = ''; return; }
    node.textContent = text;
    node.hidden = false;
  }
  function updateSaveState(kind) {
    var dot = $('saveDot');
    var label = $('saveState');
    dot.className = 'save-dot';
    if (kind === 'offline') label.textContent = '未连接宿主 · 决定可复制';
    else if (kind === 'connecting') { dot.classList.add('dirty'); label.textContent = '正在连接宿主…'; }
    else if (kind === 'connected') label.textContent = '已连接宿主 · 草稿自动保存';
    else if (kind === 'saving') { dot.classList.add('dirty'); label.textContent = '正在保存草稿…'; }
    else if (kind === 'saved') { dot.classList.add('saved'); label.textContent = '草稿已自动保存'; }
    else if (kind === 'local') { dot.classList.add('saved'); label.textContent = '草稿已保存在本窗口'; }
    else if (kind === 'restored') { dot.classList.add('saved'); label.textContent = '已恢复上次草稿'; }
    else if (kind === 'error') { dot.classList.add('error'); label.textContent = '草稿保存失败，编辑仍在本页'; }
    else if (kind === 'submitted') { dot.classList.add('saved'); label.textContent = '已提交给模型'; }
  }

  function snapshot() {
    var clone = docNode().cloneNode(true);
    clone.querySelectorAll('.is-focus, .doc-flash, [data-caret-marker]').forEach(function (node) {
      node.classList.remove('is-focus', 'doc-flash');
      if (node.hasAttribute('data-caret-marker')) node.parentNode.removeChild(node);
    });
    return {
      dataVersion: DATA.dataVersion,
      html: clone.innerHTML,
      manualBlocks: Array.from(state.manualBlocks),
      resolutions: Object.assign({}, state.resolutions),
      saved_at: new Date().toISOString(),
    };
  }
  function applyDraft(saved) {
    if (!saved || saved.dataVersion !== DATA.dataVersion || typeof saved.html !== 'string') return false;
    docNode().innerHTML = sanitizeHtml(saved.html);
    state.manualBlocks = new Set(Array.isArray(saved.manualBlocks) ? saved.manualBlocks : []);
    state.resolutions = Object.assign({}, saved.resolutions || {});
    state.undoStack = [];
    state.draftSavedAt = saved.saved_at || '';
    updateUndoButton();
    updateStatusNow();
    state.restored = true;
    return true;
  }
  function sanitizeHtml(html) {
    try {
      var parsed = new DOMParser().parseFromString('<div id="root">' + html + '</div>', 'text/html');
      var root = parsed.getElementById('root');
      if (!root) return '';
      root.querySelectorAll('script,iframe,object,embed,link,style,meta').forEach(function (node) { node.remove(); });
      root.querySelectorAll('*').forEach(function (node) {
        Array.prototype.slice.call(node.attributes).forEach(function (attribute) {
          if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
          if ((attribute.name === 'href' || attribute.name === 'src') && /^\s*javascript:/i.test(attribute.value)) {
            node.removeAttribute(attribute.name);
          }
        });
      });
      return root.innerHTML;
    } catch (error) {
      return '';
    }
  }
  function markDirty() {
    state.dirty = true;
    state.submitted = false;
    updateSaveState('saving');
    clearTimeout(draftTimer);
    draftTimer = setTimeout(persistDraft, 600);
  }
  function persistDraft() {
    var saved = snapshot();
    if (review && review.capabilities && review.capabilities.indexOf('draft') >= 0) {
      review.draft(saved).then(function () {
        state.dirty = false;
        state.draftSavedAt = saved.saved_at;
        updateSaveState(state.submitted ? 'submitted' : 'saved');
      }, function () { updateSaveState('error'); });
      return;
    }
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify(saved));
      state.dirty = false;
      state.draftSavedAt = saved.saved_at;
      updateSaveState('local');
    } catch (error) { updateSaveState('error'); }
  }
  function restoreLocalDraft() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
      if (applyDraft(saved)) return true;
    } catch (error) { /* 忽略坏草稿 */ }
    return false;
  }
  function restoreHostDraft() {
    if (!review || !review.capabilities || review.capabilities.indexOf('draft') < 0) return;
    review.readText('review-draft.json', { optional: true }).then(function (text) {
      if (!text) return;
      var saved = JSON.parse(text);
      if (!state.draftSavedAt || (saved.saved_at && saved.saved_at > state.draftSavedAt)) {
        if (applyDraft(saved)) {
          setNotice('已从宿主草稿恢复上次未提交的内容。');
          updateSaveState('restored');
        }
      }
    }, function () { /* 没有草稿就算了 */ });
  }

  /* ------------------------------------------------------------- 序列化 / 提交 */

  function textOf(node) {
    var out = '';
    Array.prototype.forEach.call(node.childNodes, function (child) {
      if (child.nodeType === 3) out += child.nodeValue;
      else if (child.nodeType === 1) {
        if (child.tagName === 'BR') out += '\n';
        else out += textOf(child);
      }
    });
    return out;
  }
  function resolveClone(clone) {
    ORDER.forEach(function (id) {
      var item = itemOf(id);
      var reds = Array.prototype.slice.call(clone.querySelectorAll('.ai-del[data-ai-id="' + cssEscape(id) + '"]'));
      var greens = Array.prototype.slice.call(clone.querySelectorAll('.ai-ins[data-ai-id="' + cssEscape(id) + '"]'));
      var checks = Array.prototype.slice.call(clone.querySelectorAll('.ai-check[data-ai-id="' + cssEscape(id) + '"]'));
      if (item.layer === 'l3') {
        unwrapNodes(checks);
        return;
      }
      if (!reds.length && !greens.length) return;
      if (reds.length && greens.length) {
        removeNodes(reds);
        unwrapNodes(greens);
        return;
      }
      if (reds.length) {
        // 原本有绿色建议、现在只剩红色：用户手动删掉了建议 → 视为保留原文
        if (item.hadGreen) unwrapNodes(reds);
        else removeNodes(reds);
        return;
      }
      unwrapNodes(greens);
    });
    // 兜底：清掉任何没被认领的标记
    clone.querySelectorAll('.ai-del').forEach(function (node) { node.remove(); });
    clone.querySelectorAll('.ai-ins,.ai-check').forEach(function (node) { unwrap(node); });
  }
  function serializeDoc(clone) {
    var parts = [];
    Array.prototype.forEach.call(clone.childNodes, function (node) {
      if (node.nodeType === 3) {
        var raw = node.nodeValue.replace(/\u00a0/g, ' ').trim();
        if (raw) parts.push(raw);
        return;
      }
      if (node.nodeType !== 1) return;
      if (node.classList && node.classList.contains('doc-divider')) { parts.push('---'); return; }
      var text = textOf(node).replace(/\u00a0/g, ' ').trim();
      if (!text) return;
      if (/^H[1-6]$/.test(node.tagName)) {
        parts.push('#'.repeat(Number(node.tagName.slice(1))) + ' ' + text);
      } else if (node.tagName === 'BLOCKQUOTE') {
        parts.push(text.split('\n').map(function (line) { return '> ' + line; }).join('\n'));
      } else if (node.classList && node.classList.contains('doc-li')) {
        parts.push('- ' + text);
      } else {
        parts.push(text);
      }
    });
    return parts.join('\n\n');
  }
  function buildPayload() {
    var clone = docNode().cloneNode(true);
    resolveClone(clone);
    var finalText = serializeDoc(clone);
    var rejected = rejectedIds();
    var accepted = acceptedOrDefault();
    var checked = checkedL3();
    var manualBlocks = Array.from(state.manualBlocks).filter(function (id) {
      return docNode().querySelector('[data-block-id="' + cssEscape(id) + '"]');
    });
    return {
      contract: 'editor-decisions/2',
      article: DATA.article,
      submitted_at: new Date().toISOString(),
      page: { host: review ? 'dsh' : 'none', pre_check: false },
      final_text: finalText,
      l3_find: checked,
      default_accepted: true,
      accepted_changes: accepted,
      rejected_changes: rejected,
      manual_blocks: manualBlocks,
      stats: {
        total_changes: ORDER.length,
        accepted: accepted.length,
        rejected: rejected.length,
        l3_checked: checked.length,
        manual_blocks: manualBlocks.length,
      },
    };
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(textarea);
      textarea.select();
      try { document.execCommand('copy'); resolve(); } catch (error) { reject(error); }
      document.body.removeChild(textarea);
    });
  }
  function copyDecisions() {
    copyText(JSON.stringify(buildPayload(), null, 2)).then(function () {
      toast('已复制当前正文与校对结果 JSON。');
    }, function () { toast('复制失败：请把最终正文或决定直接说回对话。'); });
  }
  function submit() {
    var payload = buildPayload();
    if (!review) {
      copyText(JSON.stringify(payload, null, 2)).then(function () {
        setNotice('没有审阅宿主：最终正文与决定 JSON 已复制到剪贴板，粘回对话即可。');
        toast('已复制最终正文与校对结果 JSON。');
      }, function () { toast('复制失败：请把页面上的决定直接说回对话。'); });
      return;
    }
    var button = $('submitBtn');
    clearTimeout(draftTimer);
    state.dirty = false;
    button.disabled = true;
    button.textContent = '提交中…';
    review.write(payload).then(function () {
      return review.wake({ unit: 'decisions' });
    }).then(function (wake) {
      state.submitted = true;
      button.disabled = false;
      button.textContent = '再次提交';
      updateSaveState('submitted');
      if (wake && wake.ok === false) {
        toast('已写入反馈，但唤醒未被接受；回对话说一声「校对决定已提交」。');
      } else {
        setNotice('已写入 review-feedback.json，并请求唤醒模型。');
        toast('已提交给模型。');
      }
    }).catch(function (error) {
      button.disabled = false;
      button.textContent = '提交给模型';
      updateSaveState('error');
      toast('提交失败：' + (error && error.message ? error.message : error) + '。可先用「复制结果」兜底。');
    });
  }

  /* ------------------------------------------------------------- 抽屉 / 宿主 */

  function openRail() {
    document.body.classList.add('rail-open');
    $('railScrim').hidden = false;
  }
  function closeRail() {
    document.body.classList.remove('rail-open');
    $('railScrim').hidden = true;
  }
  function bootBridge() {
    if (!window.ReviewBridge) {
      if (!state.restored) updateSaveState('offline');
      return;
    }
    updateSaveState('connecting');
    var timer = setTimeout(function () { if (!review) updateSaveState('offline'); }, 6000);
    window.ReviewBridge.connect().then(function (handle) {
      clearTimeout(timer);
      review = handle;
      updateSaveState('connected');
      setNotice('已连接审阅宿主：编辑会存成草稿，提交后模型收到 final_text。');
      restoreHostDraft();
    }, function () {
      clearTimeout(timer);
      updateSaveState('offline');
    });
  }

  /* ------------------------------------------------------------- 事件 */

  function bindEvents() {
    $('undoBtn').addEventListener('click', undo);
    $('listBtn').addEventListener('click', function () {
      if (document.body.classList.contains('rail-open')) closeRail(); else openRail();
    });
    $('railScrim').addEventListener('click', closeRail);
    $('reloadBtn').addEventListener('click', function () {
      if (state.dirty) persistDraft();
      location.reload();
    });
    $('copyBtn').addEventListener('click', copyDecisions);
    $('submitBtn').addEventListener('click', submit);

    $('railFilters').addEventListener('click', function (event) {
      var button = event.target.closest('[data-filter]');
      if (!button) return;
      state.filter = button.dataset.filter;
      var buttons = $('railFilters').querySelectorAll('[data-filter]');
      for (var i = 0; i < buttons.length; i += 1) buttons[i].classList.toggle('active', buttons[i] === button);
      renderRail();
    });
    $('railList').addEventListener('click', function (event) {
      var row = event.target.closest('[data-rail-id]');
      if (row) focusItem(row.dataset.railId);
    });

    docNode().addEventListener('click', function (event) {
      var check = event.target.closest('.ai-check');
      if (check) {
        event.preventDefault();
        toggleCheck(check.dataset.aiId);
        return;
      }
      var token = event.target.closest('.ai-del,.ai-ins');
      if (token) {
        event.preventDefault();
        var isDel = token.classList.contains('ai-del');
        var mode = isDel === Boolean(event.altKey) ? 'apply' : 'reject';
        applyItem(token.dataset.aiId, mode);
      }
    });
    docNode().addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var active = document.activeElement;
      if (!active || !active.matches || !active.matches('.ai-del,.ai-ins,.ai-check')) return;
      event.preventDefault();
      if (active.classList.contains('ai-check')) toggleCheck(active.dataset.aiId);
      else {
        var isDelKey = active.classList.contains('ai-del');
        applyItem(active.dataset.aiId, isDelKey === Boolean(event.altKey) ? 'apply' : 'reject');
      }
    });
    docNode().addEventListener('input', function () {
      state.undoStack = [];
      updateUndoButton();
      markManualBlock();
      markDirty();
      scheduleStatus();
    });
    docNode().addEventListener('focus', function () {
      try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (error) { /* 老浏览器就算了 */ }
    });
    docNode().addEventListener('paste', function (event) {
      if (!event.clipboardData) return;
      event.preventDefault();
      var text = event.clipboardData.getData('text/plain');
      try {
        document.execCommand('insertText', false, text);
      } catch (error) {
        var selection = window.getSelection();
        if (!selection || !selection.rangeCount) return;
        var range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
    docNode().addEventListener('mousedown', function () {
      // 点正文空白处取消清单里的当前行（不重绘正文）
      if (state.activeItem) {
        setTimeout(function () {
          if (!window.getSelection().toString()) {
            state.activeItem = null;
            renderRail();
          }
        }, 0);
      }
    });

    document.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z'
        && state.undoStack.length) {
        event.preventDefault();
        undo();
        return;
      }
      if (event.key === 'Escape') {
        if (document.body.classList.contains('rail-open')) closeRail();
      }
    });

    window.addEventListener('beforeunload', function (event) {
      if (!state.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    });

    var media = window.matchMedia('(prefers-color-scheme: dark)');
    function applyTheme() { document.body.toggleAttribute('data-ds-dark-theme', media.matches); }
    applyTheme();
    if (media.addEventListener) media.addEventListener('change', applyTheme);
  }

  /* ------------------------------------------------------------- 启动 */

  function boot() {
    renderHead();
    renderDoc();
    var restored = restoreLocalDraft();
    bindEvents();
    updateStatusNow();
    updateUndoButton();
    if (restored) {
      updateSaveState('restored');
      setNotice('已恢复上次未提交的草稿。可以继续改，或直接提交。');
    }
    bootBridge();
    if (!restored && !window.ReviewBridge) updateSaveState('offline');
    state.submitted = false;
    booted = true;
  }

  boot();
  window.__PROOFREAD_APP__ = {
    state: state,
    payload: buildPayload,
    finalText: function () { return buildPayload().final_text; },
    reset: function () { docNode().innerHTML = BLOCKS.map(blockHtml).join(''); state.manualBlocks.clear(); state.resolutions = {}; state.undoStack = []; updateUndoButton(); updateStatusNow(); },
  };
}());
