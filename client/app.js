// MindChat Canvas - Core Logic

// State variables
let nodes = [];
let annotations = [];
// knowledge-canvas 的非树状关系单独保存，避免破坏 qibu 既有 parentId 树模型。
let knowledgeEdges = [];
let viewMode = '2d'; // '2d' or '3d'
const DEFAULT_3D_ROTATE_X = -12;
const DEFAULT_3D_ROTATE_Y = -32;
let rotateX = DEFAULT_3D_ROTATE_X; // default 3D camera angles
let rotateY = DEFAULT_3D_ROTATE_Y;
let isRotatingCamera = false;
let rotateStartX = 0;
let rotateStartY = 0;
let initialRotateX = 0;
let initialRotateY = 0;
let transformX = -25000 + (window.innerWidth - 320) / 2; // Default center adjusted for sidebar
let transformY = -25000 + window.innerHeight / 2;
let scale = 1.0;
let layoutZoomSupported = null;
let layoutZoomTranslateUnscaled = true;
let zoomSettleTimer = null;
const ZOOM_SETTLE_MS = 140;

// Configuration state
let config = {
  provider: 'mock',
  apiKey: '',
  endpoint: 'https://generativelanguage.googleapis.com',
  model: 'gemini-1.5-flash',
};
const storageModule = window.MindChatModules.createStorageModule({
  currentLang: () => currentLang,
  notify: (message) => alert(message)
});
const importerModule = window.MindChatModules.createImporterModule();

function safeLocalStorageSet(key, value, options = {}) {
  const didSaveLocal = storageModule.safeSet(key, value, options);
  if (key && key.startsWith('mindchat_') && options.mirrorIndexedDb !== false) {
    storageModule.indexedDb.set(key, value).catch(err => {
      console.warn('Failed to mirror local data to IndexedDB:', err);
    });
  }
  return didSaveLocal;
}

function removeStoredDataKey(key) {
  localStorage.removeItem(key);
  if (key && key.startsWith('mindchat_')) {
    storageModule.indexedDb.remove(key).catch(err => {
      console.warn('Failed to remove IndexedDB mirror:', err);
    });
  }
}

// Drag state
let isDraggingCanvas = false;
let dragStartX = 0;
let dragStartY = 0;
let canvasInitialX = 0;
let canvasInitialY = 0;

let draggedNode = null;
let nodeDragStartX = 0;
let nodeDragStartY = 0;
let nodeInitialX = 0;
let nodeInitialY = 0;

// Selection state
let selectedNodeIds = [];
let isSelecting = false;
let startSelX = 0;
let startSelY = 0;
let lastActiveNodeId = null;
let manualLinkSourceNodeId = null;

// Canvas interaction mode state
let canvasMode = 'select'; // 'select' (pointer) or 'pan' (hand)
let spaceHeld = false;
let commentMode = false;
let activeAnnotationDraftId = null;

// Card layout mode: 'normal' (narrow, grows tall) or 'wide' (wide & flat,
// content clamped to ~3 lines, cards stacked top-to-bottom)
const CARD_WIDTH_NORMAL = 300;
const CARD_WIDTH_WIDE = 1320; // ~100 CJK chars per line at 13px
let cardLayout = 'normal';
let minimapVisible = true;
function getCardWidth() {
  return cardLayout === 'wide' ? CARD_WIDTH_WIDE : CARD_WIDTH_NORMAL;
}

function setMinimapVisible(visible) {
  minimapVisible = !!visible;
  document.body.classList.toggle('minimap-hidden', !minimapVisible);
  const btn = document.getElementById('nav-toggle-btn');
  if (btn) {
    btn.classList.toggle('active', minimapVisible);
    btn.title = minimapVisible ? '隐藏导航地图' : '显示导航地图';
  }
  try { localStorage.setItem('mindchat_minimap_visible', minimapVisible ? '1' : '0'); } catch (e) {}
  if (minimapVisible) updateMinimap();
}

const CARD_SIZE_MIN_WIDTH = 200;
const CARD_SIZE_MAX_WIDTH = 1800;
const CARD_SIZE_MIN_HEIGHT = 120;
const CARD_SIZE_MAX_HEIGHT = 1400;
const HISTORY_LIMIT = 80;
let historyUndoStack = [];
let historyRedoStack = [];
let historySnapshot = null;
let historyPaused = false;
let historyPendingLabel = '';

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function getActiveSizeNode() {
  for (let i = selectedNodeIds.length - 1; i >= 0; i--) {
    const node = nodes.find(n => n.id === selectedNodeIds[i]);
    if (node) return node;
  }
  return null;
}

function rememberActiveNode(id) {
  if (nodes.some(n => n.id === id)) {
    lastActiveNodeId = id;
  }
}

function isManualLinkableNote(node) {
  return !!node && node.role === 'user' && node.question === undefined && !node.isLoading;
}

function isAssistantRole(role) {
  return role === 'assistant' || role === 'model';
}

function canEditNodeContent(node) {
  return !!node && node.question === undefined && !isAssistantRole(node.role) && !node.isLoading;
}

function canEditNodeQuestion(node) {
  return !!node && node.question !== undefined && !node.isLoading;
}

function isNodeAncestor(ancestorId, nodeId) {
  let current = nodes.find(n => n.id === nodeId);
  const seen = new Set();
  while (current && current.parentId && !seen.has(current.id)) {
    if (current.parentId === ancestorId) return true;
    seen.add(current.id);
    current = nodes.find(n => n.id === current.parentId);
  }
  return false;
}

function getNextBlankCardPosition() {
  const anchor = nodes.find(n => n.id === lastActiveNodeId) || getActiveSizeNode();
  if (!anchor) {
    return {
      x: 25000 - 150 + (Math.random() - 0.5) * 100,
      y: 25000 - 100 + (Math.random() - 0.5) * 100,
      z: 0
    };
  }

  const gap = 90;
  const cardWidth = getNodeRenderedWidth(anchor);
  const cardHeight = getNodeRenderedHeight(anchor);
  let x = anchor.x + cardWidth + gap;
  let y = anchor.y;
  const newWidth = getCardWidth();
  const newHeight = 180;

  const overlaps = () => nodes.some(n => {
    const w = getNodeRenderedWidth(n);
    const h = getNodeRenderedHeight(n);
    return !(x > n.x + w + 24 || x + newWidth < n.x - 24 || y > n.y + h + 24 || y + newHeight < n.y - 24);
  });

  let attempts = 0;
  while (overlaps() && attempts < 12) {
    y += Math.min(260, cardHeight + 42);
    attempts += 1;
  }

  return { x, y, z: anchor.z || 0 };
}

function canFinishManualLink(sourceId, targetId) {
  const source = nodes.find(n => n.id === sourceId);
  const target = nodes.find(n => n.id === targetId);
  return !!source &&
    !!target &&
    source.id !== target.id &&
    isManualLinkableNote(source) &&
    isManualLinkableNote(target) &&
    !isNodeAncestor(target.id, source.id);
}

function updateManualLinkModeUI() {
  const source = nodes.find(n => n.id === manualLinkSourceNodeId);
  if (!source) manualLinkSourceNodeId = null;

  document.body.classList.toggle('manual-link-mode', !!manualLinkSourceNodeId);
  document.querySelectorAll('.chat-card').forEach(card => {
    const node = nodes.find(n => n.id === card.id);
    const isSource = !!manualLinkSourceNodeId && card.id === manualLinkSourceNodeId;
    const isTarget = !!manualLinkSourceNodeId && canFinishManualLink(manualLinkSourceNodeId, card.id);
    card.classList.toggle('manual-link-source', isSource);
    card.classList.toggle('manual-link-target', isTarget);
    card.classList.toggle('manual-link-disabled', !!manualLinkSourceNodeId && !isSource && !isTarget && !!node);
  });

  updateCursorMode();
}

function startManualLinkMode(sourceId) {
  const source = nodes.find(n => n.id === sourceId);
  if (!isManualLinkableNote(source)) return;
  manualLinkSourceNodeId = sourceId;
  rememberActiveNode(sourceId);
  selectCardNode(sourceId);
  updateManualLinkModeUI();
}

function cancelManualLinkMode() {
  if (!manualLinkSourceNodeId) return;
  manualLinkSourceNodeId = null;
  updateManualLinkModeUI();
}

function getNodeRenderedWidth(node) {
  const el = node ? document.getElementById(node.id) : null;
  return Math.round(node?.width || (el ? el.offsetWidth : getCardWidth()));
}

function getNodeRenderedHeight(node) {
  const el = node ? document.getElementById(node.id) : null;
  return Math.round(node?.height || (el ? el.offsetHeight : 180));
}

function getCardSizeAxisControls() {
  return {
    applyWidth: document.getElementById('card-size-apply-width'),
    applyHeight: document.getElementById('card-size-apply-height')
  };
}

function ensureCardSizeAxisSelection(changedInput = null) {
  const { applyWidth, applyHeight } = getCardSizeAxisControls();
  if (!applyWidth || !applyHeight) return;
  if (!applyWidth.checked && !applyHeight.checked) {
    (changedInput || applyWidth).checked = true;
  }
}

function getCardSizeApplyAxes() {
  const applyAll = document.getElementById('card-size-apply-all');
  const { applyWidth, applyHeight } = getCardSizeAxisControls();
  if (!applyAll?.checked) return { width: true, height: true };
  return {
    width: applyWidth ? applyWidth.checked : true,
    height: applyHeight ? applyHeight.checked : true
  };
}

function getCardSizeAxisLabel(axes) {
  if (axes.width && axes.height) return '宽度和高度';
  if (axes.width) return '宽度';
  if (axes.height) return '高度';
  return '尺寸';
}

function updateCardSizePanel() {
  const inspector = document.getElementById('card-size-section');
  const widthInput = document.getElementById('card-width-input');
  const heightInput = document.getElementById('card-height-input');
  const applyAll = document.getElementById('card-size-apply-all');
  const { applyWidth, applyHeight } = getCardSizeAxisControls();
  const status = document.getElementById('card-size-status');
  const focusBtn = document.getElementById('focus-selected-card-btn');
  const deleteBtn = document.getElementById('delete-selected-card-btn');
  if (!widthInput || !heightInput || !applyAll || !status) return;

  const node = getActiveSizeNode();
  const hasNode = !!node;
  applyAll.disabled = !hasNode || nodes.length === 0;
  ensureCardSizeAxisSelection();
  const axes = getCardSizeApplyAxes();
  widthInput.disabled = !hasNode || (applyAll.checked && !axes.width);
  heightInput.disabled = !hasNode || (applyAll.checked && !axes.height);
  if (applyWidth) applyWidth.disabled = !hasNode || !applyAll.checked;
  if (applyHeight) applyHeight.disabled = !hasNode || !applyAll.checked;
  if (focusBtn) focusBtn.disabled = !hasNode;
  if (deleteBtn) deleteBtn.disabled = !hasNode;

  if (!hasNode) {
    if (inspector) inspector.classList.add('hidden');
    widthInput.value = '';
    heightInput.value = '';
    status.textContent = '先选中一张卡片';
    return;
  }

  if (inspector) inspector.classList.remove('hidden');

  if (document.activeElement !== widthInput) {
    widthInput.value = getNodeRenderedWidth(node);
  }
  if (document.activeElement !== heightInput) {
    heightInput.value = getNodeRenderedHeight(node);
  }

  status.textContent = applyAll.checked
    ? `将同步${getCardSizeAxisLabel(axes)}到全部 ${nodes.length} 张卡片`
    : `当前卡片 ${selectedNodeIds.indexOf(node.id) + 1} / ${Math.max(1, selectedNodeIds.length)}`;
}

function setCardNodeSize(node, width, height, axes = { width: true, height: true }) {
  if (axes.width) node.width = width;
  if (axes.height) node.height = height;

  const el = document.getElementById(node.id);
  if (!el) return;
  if (axes.width) el.style.width = `${width}px`;
  if (axes.height) el.style.height = `${height}px`;
  el.classList.add('card-resized');
}

function applyCardSizeInputs() {
  const widthInput = document.getElementById('card-width-input');
  const heightInput = document.getElementById('card-height-input');
  const applyAll = document.getElementById('card-size-apply-all');
  if (!widthInput || !heightInput || !applyAll) return;

  const activeNode = getActiveSizeNode();
  if (!activeNode) {
    updateCardSizePanel();
    return;
  }

  const width = clampNumber(widthInput.value, CARD_SIZE_MIN_WIDTH, CARD_SIZE_MAX_WIDTH);
  const height = clampNumber(heightInput.value, CARD_SIZE_MIN_HEIGHT, CARD_SIZE_MAX_HEIGHT);
  if (width === null || height === null) return;

  widthInput.value = width;
  heightInput.value = height;

  const targets = applyAll.checked ? nodes : [activeNode];
  ensureCardSizeAxisSelection();
  const axes = getCardSizeApplyAxes();
  targets.forEach(node => setCardNodeSize(node, width, height, axes));
  drawAllConnections();
  saveBoard(applyAll.checked ? `同步卡片${getCardSizeAxisLabel(axes)}` : '调整卡片尺寸');
  updateCardSizePanel();
}

function applyCardSizeInputsIfReady() {
  const widthInput = document.getElementById('card-width-input');
  const heightInput = document.getElementById('card-height-input');
  if (!widthInput || !heightInput) return;

  const width = Number(widthInput.value);
  const height = Number(heightInput.value);
  if (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= CARD_SIZE_MIN_WIDTH &&
    height >= CARD_SIZE_MIN_HEIGHT
  ) {
    applyCardSizeInputs();
  }
}

function setupCardSizePanel() {
  const widthInput = document.getElementById('card-width-input');
  const heightInput = document.getElementById('card-height-input');
  const applyAll = document.getElementById('card-size-apply-all');
  const { applyWidth, applyHeight } = getCardSizeAxisControls();
  const focusBtn = document.getElementById('focus-selected-card-btn');
  const deleteBtn = document.getElementById('delete-selected-card-btn');
  if (!widthInput || !heightInput || !applyAll) return;

  widthInput.addEventListener('input', applyCardSizeInputsIfReady);
  heightInput.addEventListener('input', applyCardSizeInputsIfReady);
  widthInput.addEventListener('change', applyCardSizeInputs);
  heightInput.addEventListener('change', applyCardSizeInputs);
  widthInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyCardSizeInputs();
  });
  heightInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyCardSizeInputs();
  });
  applyAll.addEventListener('change', () => {
    ensureCardSizeAxisSelection();
    if (applyAll.checked) applyCardSizeInputs();
    updateCardSizePanel();
  });
  [applyWidth, applyHeight].filter(Boolean).forEach(axisInput => {
    axisInput.addEventListener('change', () => {
      ensureCardSizeAxisSelection(axisInput);
      if (applyAll.checked) applyCardSizeInputs();
      updateCardSizePanel();
    });
  });
  if (focusBtn) {
    focusBtn.addEventListener('click', () => focusSelectedCard());
  }
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => deleteSelectedCards());
  }
  updateCardSizePanel();
}

function serializeBoardState() {
  return JSON.stringify(nodes);
}

function getKnowledgeEdgesStorageKey(canvasId = activeCanvasId) {
  return canvasId ? 'mindchat_knowledge_edges_' + canvasId : null;
}

function saveKnowledgeEdges() {
  const key = getKnowledgeEdgesStorageKey();
  if (key) safeLocalStorageSet(key, JSON.stringify(knowledgeEdges), { critical: true });
}

function loadKnowledgeEdges() {
  const key = getKnowledgeEdgesStorageKey();
  knowledgeEdges = [];
  if (!key) return;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || '[]');
    if (Array.isArray(parsed)) knowledgeEdges = parsed;
  } catch (e) {
    knowledgeEdges = [];
  }
}

function isConversationEdge(sourceId, targetId) {
  return nodes.some(node =>
    (node.id === targetId && node.parentId === sourceId)
    || (node.id === sourceId && node.parentId === targetId));
}

function visibleKnowledgeEdges() {
  return knowledgeEdges.filter(edge => edge && !isConversationEdge(edge.source, edge.target));
}

function exportKnowledgeInput() {
  const ordered = nodesInTreeOrder();
  const sections = ordered.map((node, index) => {
    const title = node.knowledge?.title || node.question || `对话 ${index + 1}`;
    const question = node.knowledge?.summary_q || node.question || node.content || '';
    const answer = node.knowledge?.summary_a || (node.question !== undefined ? node.content : '');
    return `## Q${index + 1}: ${String(title).trim()}\n\n问：${String(question).trim()}\n\n答：${String(answer).trim()}`;
  }).filter(Boolean);
  const text = sections.length ? sections.join('\n\n') + '\n' : '# MindChat 知识分析输入\n';
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `mindchat-knowledge-input-${Date.now()}.md`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
}

function markHistory(label) {
  historyPendingLabel = label || '';
}

function setHistoryBaseline({ clearStacks = true } = {}) {
  historySnapshot = serializeBoardState();
  if (clearStacks) {
    historyUndoStack = [];
    historyRedoStack = [];
  }
  updateHistoryUI();
}

function pushHistoryEntry(before, after, label) {
  if (!before || before === after) return;
  const entry = {
    before,
    after,
    label: label || '修改白板',
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };
  historyUndoStack.push(entry);
  if (historyUndoStack.length > HISTORY_LIMIT) historyUndoStack.shift();
  historyRedoStack = [];
}

function restoreBoardSnapshot(snapshot) {
  try {
    historyPaused = true;
    nodes = JSON.parse(snapshot);
    selectedNodeIds = selectedNodeIds.filter(id => nodes.some(n => n.id === id));
    if (activeCanvasId) {
      safeLocalStorageSet('mindchat_board_' + activeCanvasId, snapshot, { critical: true });
    }
    historySnapshot = snapshot;
    renderBoard();
  } catch (err) {
    console.error(err);
  } finally {
    historyPaused = false;
    updateHistoryUI();
  }
}

function undoHistory() {
  const entry = historyUndoStack.pop();
  if (!entry) return;
  historyRedoStack.push(entry);
  restoreBoardSnapshot(entry.before);
}

function redoHistory() {
  const entry = historyRedoStack.pop();
  if (!entry) return;
  historyUndoStack.push(entry);
  restoreBoardSnapshot(entry.after);
}

function jumpToHistoryIndex(index) {
  if (index < 0 || index >= historyUndoStack.length) return;
  const entry = historyUndoStack[index];
  const moved = historyUndoStack.splice(index + 1);
  historyRedoStack.push(...moved.reverse());
  restoreBoardSnapshot(entry.after);
}

function updateHistoryUI() {
  const undoButtons = [
    document.getElementById('undo-btn'),
    document.getElementById('history-panel-undo')
  ].filter(Boolean);
  const redoButtons = [
    document.getElementById('redo-btn'),
    document.getElementById('history-panel-redo')
  ].filter(Boolean);
  undoButtons.forEach(btn => { btn.disabled = historyUndoStack.length === 0; });
  redoButtons.forEach(btn => { btn.disabled = historyRedoStack.length === 0; });

  const list = document.getElementById('history-list');
  if (!list) return;
  list.innerHTML = '';

  if (historyUndoStack.length === 0 && historyRedoStack.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = '暂无修改记录';
    list.appendChild(empty);
    return;
  }

  historyUndoStack.slice().reverse().forEach((entry, reverseIndex) => {
    const index = historyUndoStack.length - 1 - reverseIndex;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'history-item';
    item.innerHTML = `<span>${entry.label}</span><small>${entry.time}</small>`;
    item.addEventListener('click', () => jumpToHistoryIndex(index));
    list.appendChild(item);
  });

  historyRedoStack.slice().reverse().forEach(entry => {
    const item = document.createElement('div');
    item.className = 'history-item history-item-redo';
    item.innerHTML = `<span>${entry.label}</span><small>已撤销</small>`;
    list.appendChild(item);
  });
}

function setupHistoryControls() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  const toggleBtn = document.getElementById('history-toggle-btn');
  const panel = document.getElementById('history-panel');
  const closeBtn = document.getElementById('history-close-btn');
  const panelUndo = document.getElementById('history-panel-undo');
  const panelRedo = document.getElementById('history-panel-redo');

  if (undoBtn) undoBtn.addEventListener('click', undoHistory);
  if (redoBtn) redoBtn.addEventListener('click', redoHistory);
  if (panelUndo) panelUndo.addEventListener('click', undoHistory);
  if (panelRedo) panelRedo.addEventListener('click', redoHistory);
  if (toggleBtn && panel) {
    toggleBtn.addEventListener('click', () => panel.classList.toggle('hidden'));
  }
  if (closeBtn && panel) {
    closeBtn.addEventListener('click', () => panel.classList.add('hidden'));
  }

  updateHistoryUI();
}

// Connection flow effect: animated links coloured per continuous conversation.
let flowMode = false;
const BRANCH_PALETTE = ['#a855f7', '#22d3ee', '#34d399', '#f59e0b', '#f472b6', '#60a5fa', '#eab308', '#ef4444'];
let branchColors = {}; // childNodeId -> colour of the edge ending at it

// Assign a colour to each edge: a single chain keeps its colour; at every fork
// each branch gets a fresh colour, so each continuous conversation (root -> leaf
// path) is visually distinct once it diverges from the shared trunk.
function recomputeBranchColors() {
  branchColors = {};
  let next = 0;
  const roots = nodes.filter(n => !n.parentId || !nodes.find(p => p.id === n.parentId));
  const walk = (node, color) => {
    const kids = nodes.filter(n => n.parentId === node.id);
    const fork = kids.length > 1;
    kids.forEach(k => {
      const c = fork ? BRANCH_PALETTE[next++ % BRANCH_PALETTE.length] : color;
      branchColors[k.id] = c;
      walk(k, c);
    });
  };
  roots.forEach(r => {
    const base = BRANCH_PALETTE[next++ % BRANCH_PALETTE.length];
    branchColors[r.id] = base;
    walk(r, base);
  });
}

function getBranchColor(childId) {
  return branchColors[childId] || 'var(--connection-line-color)';
}

function setFlowMode(on) {
  flowMode = !!on;
  document.body.classList.toggle('flow-anim', flowMode);
  const btn = document.getElementById('flow-toggle-btn');
  if (btn) btn.classList.toggle('active', flowMode);
  try { localStorage.setItem('mindchat_flow', flowMode ? '1' : '0'); } catch (e) {}
  drawAllConnections();
}

let currentLang = 'zh';

// Theme: dark (default) + light, extensible via THEMES.
const THEMES = ['dark', 'light'];
let theme = 'dark';
function setTheme(name) {
  if (!THEMES.includes(name)) name = 'dark';
  theme = name;
  document.body.setAttribute('data-theme', name);
  try { localStorage.setItem('mindchat_theme', name); } catch (e) {}
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.textContent = name === 'light' ? '☀️' : '🌙';
}
function cycleTheme() {
  setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]);
}

function supportsCrispLayoutZoom() {
  if (layoutZoomSupported !== null) return layoutZoomSupported;

  layoutZoomSupported = false;
  layoutZoomTranslateUnscaled = true;

  if (!document.body || !window.CSS || !CSS.supports || !CSS.supports('zoom', '1.1')) {
    return false;
  }

  const host = document.createElement('div');
  const probe = document.createElement('div');
  host.style.cssText = [
    'position:absolute',
    'left:0',
    'top:0',
    'width:0',
    'height:0',
    'overflow:visible',
    'visibility:hidden',
    'pointer-events:none',
    'transform-origin:0 0',
    'zoom:2',
    'transform:translate(50px, 0)'
  ].join(';');
  probe.style.cssText = [
    'position:absolute',
    'left:100px',
    'top:0',
    'width:10px',
    'height:10px'
  ].join(';');

  host.appendChild(probe);
  document.body.appendChild(host);
  const rect = probe.getBoundingClientRect();
  document.body.removeChild(host);

  layoutZoomSupported = Math.abs(rect.width - 20) < 1;
  layoutZoomTranslateUnscaled = Math.abs(rect.left - 250) <= Math.abs(rect.left - 300);
  return layoutZoomSupported;
}

function applyTransformZoom() {
  canvasEl.style.zoom = '';
  canvasEl.classList.remove('layout-zoom-active');
  canvasEl.style.transform = `translate(${transformX}px, ${transformY}px) scale(${scale})`;
}

function settleCrispZoomSoon() {
  if (zoomSettleTimer) clearTimeout(zoomSettleTimer);
  if (viewMode !== '2d' || !supportsCrispLayoutZoom()) return;

  zoomSettleTimer = setTimeout(() => {
    zoomSettleTimer = null;
    updateTransform();
  }, ZOOM_SETTLE_MS);
}

const translations = {
  zh: {
    logoTitle: 'MindChat Canvas',
    title: 'MindChat Canvas',
    tagline: '分支对话 / 思路白板',
    aiSettings: '🤖 AI 引擎设置',
    provider: '服务商',
    mockAi: '✨ 模拟 AI (免密钥体验)',
    geminiApi: 'Gemini API (原生接口)',
    customLlm: 'Custom LLM (兼容 API)',
    apiKey: 'API 密钥 (API Key)',
    apiKeySessionNote: 'API Key 仅保存在当前浏览器会话中，关闭浏览器后需要重新输入。',
    apiEndpoint: '自定义 Endpoint',
    apiModel: '模型名称',
    boardManager: '💾 白板管理',
    importChatLog: '导入聊天记录',
    newBlankCard: '新建空白卡片',
    diagnosticsBtn: '系统诊断',
    diagnosticsTitle: '系统诊断',
    diagnosticsDesc: '查看当前模块、存储和画布状态。',
    diagnosticsRefresh: '刷新',
    diagnosticsMirror: '同步 IndexedDB 镜像',
    diagnosticsClose: '关闭',
    exportJson: '导出 JSON',
    importFile: '导入文件 (.json/.txt)',
    exportKnowledgeInput: '导出知识分析输入 (.md)',
    linkKnowledgeCards: '关联当前卡片',
    exportBackup: '导出完整备份',
    importBackup: '恢复完整备份',
    clearBoard: '清空当前画布',
    instructionsTitle: '💡 使用技巧',
    instructionsList: [
      '<strong>画布操作</strong>：在空白处按住<strong>鼠标左键拖拽</strong>以平移，滚动<strong>鼠标滚轮</strong>以缩放。',
      '<strong>生成分支</strong>：在任意卡片底部点击 <strong>“+ 发起追问”</strong>，将生成一个与之相连的子卡片。',
      '<strong>上下文记忆</strong>：AI 卡片回答时，会自动追溯它到根节点的所有祖先节点作为历史聊天记录。',
      '<strong>位置调整</strong>：拖拽卡片头部即可自由移动，连接线会自动保持对齐。'
    ],
    statusReady: '系统就绪 (模拟 AI 模式)',
    statusApi: '已配置 API',
    userRole: '用户',
    aiRole: 'AI 回复',
    dialogueRole: '对话',
    deleteCard: '删除卡片',
    deleteConfirm: '删除该卡片会同时删除其下的所有追问分支，确定吗？',
    clearConfirm: '确定清空当前画布上所有的对话卡片吗？此操作无法撤销。',
    followUp: '＋ 发起追问',
    followUpPrompt: '输入您向 AI 发起的追问问题：',
    doubleClickEdit: '双击卡片以编辑内容...',
    aiRespond: '🤖 让 AI 回答',
    aiRegenerate: '🔄 重新回答',
    modeSelectTitle: '选择与编辑模式 (V)',
    modePanTitle: '抓手平移模式 (H / 按住空格键)',
    toggleConfig: '⚙️ 配置 API',
    saveConfigBtn: '保存配置',
    importTitle: '导入已有聊天记录',
    importDesc: '粘贴您与其他 AI（如 ChatGPT, Claude, Gemini, DeepSeek 等）的对话文本或 JSON 导出数据。我们将为您把每一轮对话解析为一张张彼此相连的白板卡片，以便您直接基于任意一轮对话扩展新的分支。',
    importFormat: '解析格式',
    importAuto: '智能自动识别 (推荐)',
    importJson: '标准 JSON 数组 (含 role 与 content)',
    importText: '纯文本聊天记录 (通过“人：/AI：”标识行分段)',
    importDataLabel: '对话数据内容',
    importPlaceholder: '【示例 1 - 纯文本】\nUser: 你好，请问什么是引力波？\nAssistant: 引力波是时空弯曲中的涟漪...\n\n【示例 2 - JSON】\n[\n  { "role": "user", "content": "你好！" },\n  { "role": "model", "content": "你好！有什么我可以帮你的？" }\n]',
    importArrange: '自动以水平流水线格式排布新卡片',
    cancel: '取消',
    submit: '解析并导入',
    folderTitle: '画布库',
    addFolderBtn: '＋ 文件夹',
    folderPrompt: '请输入新建文件夹的名称：',
    canvasPrompt: '请输入新画布名称：',
    folderRenamePrompt: '请输入新文件夹名称：',
    canvasRenamePrompt: '请输入新画布名称：',
    folderDeleteConfirm: '确定要删除文件夹 “{name}” 吗？\n警告：这会永久删除该文件夹下的所有画布数据！',
    canvasDeleteConfirm: '确定要删除画布 “{name}” 吗？此操作无法撤销。',
    errorTitle: '❌ 出错啦',
    errorApiKey: '未配置 API 密钥 (API Key)。请在左侧侧边栏中输入。',
    errorApiFailed: 'API 返回的数据中未包含回复内容。',
    mockAiResponse1: '你好！我是您的画布对话助手。这是一个分支对话的演示。您可以随时点击卡片下方的“+ 发起追问”来生成新的分支！',
    mockAiResponse2: '引力波是时空弯曲中的物理涟漪，由爱因斯坦的广义相对论预测。您可以：\n1. 追问引力波是如何探测的。\n2. 追问它对宇宙学有什么重要意义。\n（点击下方“+ 发起追问”试试看吧！）',
    mockAiDefaultResponse: '收到您的输入！这是一个**画布式分支对话**的交互模拟。\n\n您刚才输入了：“*{prompt}*”\n\n在传统聊天软件中，对话是一条直线的，您无法在中间插入新的提问。而在 **MindChat Canvas** 中，您可以：\n*   **创建多分支**：回到刚才的任意卡片，输入另一个问题。\n*   **整理思路**：像脑图一样摆放不同的对话，方便归纳总结。\n*   **随时编辑**：双击卡片可以直接修改文字。\n\n您可以点击下方“+ 发起追问”继续扩展本条思路！',
    defaultProject: '项目主板',
    defaultCanvas: '欢迎画布',
    welcomeUser: '你好！欢迎使用 MindChat Canvas。在卡片下方点击“发起追问”，可向 AI 发起对话。',
    welcomeAi: '你好！我是您的思路白板助手。\n\n您可以用它来做分支对话。例如，点击这张卡片底部的“+ 发起追问”，可以向我提出不同的问题。我会生成连接线将它们串联起来！\n\n您也可以点击左侧“导入聊天记录”按钮，直接将其他地方的对话转换成这种卡片格式。',
    zoomIn: '放大',
    zoomReset: '重置视角',
    zoomOut: '缩小',
    toggleSidebar: '折叠侧边栏',
    viewModeTitle: '切换 2D / 3D 视图',
    flattenTitle: '将所有卡片拉回同一平面 (Z=0)',
    autoArrangeTitle: '自动排列卡片（树形，不重叠）',
    searchPlaceholder: '搜索卡片内容…',
    searchNoResult: '无匹配卡片',
    flowToggleTitle: '连接线流动特效（按对话着色）',
    themeToggleTitle: '切换主题（深色 / 浅色）',
    cardLayoutTitle: '切换宽扁卡片 / 上下排列',
    chatModeTitle: '切换聊天界面 / 画布视图',
    treeModeTitle: '切换树状图视图（左→右，可收起分支）',
    treeSubTreeBtn: '🌳 树状图',
    treeSubConvosBtn: '≣ 按对话列出',
    chatLocate: '↩ 在白板中查看',
    chatFollowUp: '＋ 追问',
    chatFollowUpPeek: '查看追问'
  },
  en: {
    logoTitle: 'MindChat Canvas',
    title: 'MindChat Canvas',
    tagline: 'Branching Chat / Mind Board',
    aiSettings: '🤖 AI Engine Settings',
    provider: 'Provider',
    mockAi: '✨ Simulated AI (Free Demo)',
    geminiApi: 'Gemini API (Native)',
    customLlm: 'Custom LLM (Compatible)',
    apiKey: 'API Key',
    apiKeySessionNote: 'API Key is stored only for this browser session.',
    apiEndpoint: 'Custom Endpoint',
    apiModel: 'Model Name',
    boardManager: '💾 Board Management',
    importChatLog: 'Import Chat Logs',
    newBlankCard: 'New Blank Card',
    diagnosticsBtn: 'Diagnostics',
    diagnosticsTitle: 'System Diagnostics',
    diagnosticsDesc: 'Inspect current modules, storage, and board status.',
    diagnosticsRefresh: 'Refresh',
    diagnosticsMirror: 'Sync IndexedDB Mirror',
    diagnosticsClose: 'Close',
    exportJson: 'Export JSON',
    importFile: 'Import File (.json/.txt)',
    exportKnowledgeInput: 'Export Knowledge Input (.md)',
    linkKnowledgeCards: 'Link Current Cards',
    exportBackup: 'Export Backup',
    importBackup: 'Restore Backup',
    clearBoard: 'Clear Current Canvas',
    instructionsTitle: '💡 Quick Tips',
    instructionsList: [
      '<strong>Canvas Navigation</strong>: Hold <strong>Left Mouse Button</strong> on empty space to pan; roll <strong>Mouse Wheel</strong> to zoom.',
      '<strong>Create Branch</strong>: Click <strong>"+ Add Follow-up"</strong> at the bottom of any card to create a connected child card.',
      '<strong>Context Tracing</strong>: AI responses automatically trace the conversation chain up to the root node to build correct context.',
      '<strong>Card Dragging</strong>: Drag cards by their headers; connection curves will automatically align in real-time.'
    ],
    statusReady: 'System Ready (Simulated AI)',
    statusApi: 'API Configured',
    userRole: 'User',
    aiRole: 'AI Reply',
    dialogueRole: 'Dialogue',
    deleteCard: 'Delete Card',
    deleteConfirm: 'Deleting this card will recursively delete all its follow-up branches. Are you sure?',
    clearConfirm: 'Are you sure you want to clear all cards from the canvas? This action cannot be undone.',
    followUp: '＋ Add Follow-up',
    followUpPrompt: 'Enter your follow-up prompt for the AI:',
    doubleClickEdit: 'Double click to edit content...',
    aiRespond: '🤖 Let AI Answer',
    aiRegenerate: '🔄 Re-answer',
    modeSelectTitle: 'Select & Edit Mode (V)',
    modePanTitle: 'Pan / Hand Mode (H / Hold Spacebar)',
    toggleConfig: '⚙️ Configure API',
    saveConfigBtn: 'Save Configuration',
    importTitle: 'Import Conversation Logs',
    importDesc: 'Paste text chat logs or JSON exports from ChatGPT, Claude, Gemini, DeepSeek, etc. We will parse and lay them out as a connected chain of whiteboard cards.',
    importFormat: 'Parse Format',
    importAuto: 'Smart Auto-Detect (Recommended)',
    importJson: 'Standard JSON Array (role & content)',
    importText: 'Plain Text Log (split by speaker headers)',
    importDataLabel: 'Chat Log Content',
    importPlaceholder: '[Example 1 - Plain Text]\nUser: Hello, what is gravity?\nAssistant: Gravity is...\n\n[Example 2 - JSON]\n[\n  { "role": "user", "content": "Hello!" },\n  { "role": "model", "content": "Hello! How can I help you?" }\n]',
    importArrange: 'Arrange cards in horizontal pipeline format',
    cancel: 'Cancel',
    submit: 'Parse & Import',
    folderTitle: 'Library',
    addFolderBtn: '＋ Folder',
    folderPrompt: 'Enter new folder name:',
    canvasPrompt: 'Enter new canvas name:',
    folderRenamePrompt: 'Enter new name for the folder:',
    canvasRenamePrompt: 'Enter new name for the canvas:',
    folderDeleteConfirm: 'Are you sure you want to delete folder "{name}"?\nWarning: This will permanently delete all canvases in this folder!',
    canvasDeleteConfirm: 'Are you sure you want to delete canvas "{name}"? This action cannot be undone.',
    errorTitle: '❌ Error',
    errorApiKey: 'API Key is not configured. Please enter it in the sidebar.',
    errorApiFailed: 'API response did not contain candidate content.',
    mockAiResponse1: 'Hello! I am your MindChat Canvas assistant. This is a branching chat demo. Click "+ Add Follow-up" on any card below to create a new branch!',
    mockAiResponse2: 'Gravitational waves are ripples in the curvature of spacetime predicted by Einstein. You can:\n1. Ask how they are detected.\n2. Ask why they are important for cosmology.\n(Click "+ Add Follow-up" below to try!)',
    mockAiDefaultResponse: 'Received your prompt! This is a simulation of the **Whiteboard Branching Chat**.\n\nYou entered: "*{prompt}*"\n\nIn traditional chat apps, conversation is strictly linear. In **MindChat Canvas**, you can:\n*   **Create branches**: Go back to any previous card and ask a different question.\n*   **Brainstorm**: Arrange chats like a mindmap for easier summaries.\n*   **Edit anytime**: Double click any card to modify text.\n\nClick "+ Add Follow-up" below to extend this branch!',
    defaultProject: 'Main Project',
    defaultCanvas: 'Welcome Canvas',
    welcomeUser: 'Hello! Welcome to MindChat Canvas. Click "+ Add Follow-up" at the bottom of the card to chat with the AI.',
    welcomeAi: 'Hello! I am your MindChat Canvas assistant.\n\nYou can use this whiteboard for branching conversations. Click "+ Add Follow-up" at the bottom of this card to ask a question. I will generate curves to connect them together!\n\nYou can also click "Import Chat Logs" on the left sidebar to convert external logs into cards.',
    zoomIn: 'Zoom In',
    zoomReset: 'Zoom 100%',
    zoomOut: 'Zoom Out',
    toggleSidebar: 'Toggle Sidebar',
    viewModeTitle: 'Toggle 2D / 3D View',
    flattenTitle: 'Flatten all cards to the same plane (Z=0)',
    autoArrangeTitle: 'Auto-arrange cards (tidy tree, no overlap)',
    searchPlaceholder: 'Search card content…',
    searchNoResult: 'No matching cards',
    flowToggleTitle: 'Animated flowing links (coloured per conversation)',
    themeToggleTitle: 'Toggle theme (dark / light)',
    cardLayoutTitle: 'Toggle wide / flat cards (vertical stack)',
    chatModeTitle: 'Toggle chat interface / canvas view',
    treeModeTitle: 'Toggle tree view (left→right, collapsible branches)',
    treeSubTreeBtn: '🌳 Tree',
    treeSubConvosBtn: '≣ By conversation',
    chatLocate: '↩ View on canvas',
    chatFollowUp: '＋ Follow up',
    chatFollowUpPeek: 'Follow-ups'
  }
};

function applyTranslations() {
  // Update static text elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = translations[currentLang][key];
    if (val) {
      const textNodes = Array.from(el.childNodes).filter(node => node.nodeType === Node.TEXT_NODE);
      if (textNodes.length > 0) {
        textNodes[0].textContent = val;
      } else {
        el.innerHTML = val;
      }
    }
  });

  // Update titles/tooltips
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    const val = translations[currentLang][key];
    if (val) {
      el.setAttribute('title', val);
    }
  });

  // Update input placeholders
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const key = el.getAttribute('data-i18n-ph');
    const val = translations[currentLang][key];
    if (val) {
      el.setAttribute('placeholder', val);
    }
  });

  // Update instructions list
  const listEl = document.getElementById('instructions-list');
  if (listEl) {
    listEl.innerHTML = '';
    translations[currentLang].instructionsList.forEach(item => {
      const li = document.createElement('li');
      li.innerHTML = item;
      listEl.appendChild(li);
    });
  }

  // Update placeholders
  const importTextarea = document.getElementById('import-data');
  if (importTextarea) {
    importTextarea.setAttribute('placeholder', translations[currentLang].importPlaceholder);
  }

  // Language button text toggles to show option to switch
  const langToggleBtn = document.getElementById('lang-toggle-btn');
  if (langToggleBtn) {
    langToggleBtn.innerText = currentLang === 'zh' ? 'EN' : '中文';
  }

  // Update status indicators and explorer tree
  updateStatusIndicator();
  renderExplorerTree();
}

// DOM Elements
const canvasViewport = document.getElementById('canvas-viewport');
const canvasEl = document.getElementById('canvas');
const cardsContainer = document.getElementById('cards-container');
const annotationsContainer = document.getElementById('annotations-container');
const connections3dEl = document.getElementById('connections-3d');
const svgPathsGroup = document.getElementById('svg-paths-group');
const apiKeysContainer = document.getElementById('api-keys-container');
const minimapEl = document.getElementById('canvas-minimap');
const minimapStage = document.getElementById('minimap-stage');

// Sidebar toggle state
let sidebarCollapsed = false;

// Initialize the app
window.addEventListener('DOMContentLoaded', () => {
  // Apply the saved theme before anything renders to avoid a flash.
  try { setTheme(localStorage.getItem('mindchat_theme') || 'dark'); } catch (e) {}
  loadConfig();
  // Apply the saved card layout before the board renders so cards size correctly.
  try {
    const savedLayout = localStorage.getItem('mindchat_card_layout');
    if (savedLayout === 'wide') {
      cardLayout = 'wide';
      document.body.classList.add('wide-card-mode');
    }
  } catch (e) {}
  try {
    minimapVisible = localStorage.getItem('mindchat_minimap_visible') !== '0';
    document.body.classList.toggle('minimap-hidden', !minimapVisible);
  } catch (e) {}
  loadLibrary();
  setupEventListeners();
  setupMinimapNavigation();
  setupGlobalSearch();
  setupHistoryControls();
  setMinimapVisible(minimapVisible);
  updateTransform();
  initPreviewPopover();
  // Restore the connection flow effect.
  try {
    if (localStorage.getItem('mindchat_flow') === '1') setFlowMode(true);
  } catch (e) {}
  // Restore the chat view after the board has loaded so messages are present.
  try {
    if (localStorage.getItem('mindchat_chat_mode') === '1') setChatMode(true);
  } catch (e) {}
});

// Create initial tutorial nodes
function createWelcomeNode() {
  const rootId = 'welcome_dialogue';
  const welcomeNode = {
    id: rootId,
    parentId: null,
    role: 'dialogue',
    question: '你好！欢迎使用 MindChat Canvas。在卡片下方点击“发起追问”，可向 AI 发起对话。',
    content: '你好！我是您的思路白板助手。\n\n您可以用它来做分支对话。例如，点击这张卡片底部的“+ 发起追问”，可以向我提出不同的问题。我会生成连接线将它们串联起来！\n\n您也可以点击左侧“导入聊天记录”按钮，直接将其他地方的对话转换成这种卡片格式。',
    x: 25000 - 150,
    y: 25000 - 100,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  nodes.push(welcomeNode);
  saveBoard('创建欢迎卡片');
  renderBoard();
}

// Render all nodes and connection paths
function renderBoard() {
  // Clear HTML cards and SVG paths
  cardsContainer.innerHTML = '';
  if (annotationsContainer) annotationsContainer.innerHTML = '';
  svgPathsGroup.innerHTML = '';
  connections3dEl.innerHTML = '';

  // Render cards
  nodes.forEach(node => {
    createCardDOM(node);
  });
  renderAnnotations();

  // Render connections
  if (flowMode) recomputeBranchColors();
  nodes.forEach(node => {
    if (node.parentId) {
      const parent = nodes.find(n => n.id === node.parentId);
      if (parent) {
        drawConnection(parent, node);
      }
    }
  });
  visibleKnowledgeEdges().forEach(drawKnowledgeConnection);

  // Keep the chat/tree overlays in sync when the board changes (imports, AI replies, edits)
  if (chatMode) renderChatView();
  if (treeMode) renderTreeView();
  updateCardSizePanel();
  updateManualLinkModeUI();
}

function getAnnotationStorageKey() {
  return activeCanvasId ? 'mindchat_annotations_' + activeCanvasId : null;
}

function saveAnnotations(label = '') {
  const key = getAnnotationStorageKey();
  if (!key) return;
  safeLocalStorageSet(key, JSON.stringify(annotations), { critical: true });
}

function loadAnnotations() {
  const key = getAnnotationStorageKey();
  if (!key) {
    annotations = [];
    return;
  }
  const saved = localStorage.getItem(key);
  try {
    annotations = JSON.parse(saved || '[]');
    if (!Array.isArray(annotations)) annotations = [];
  } catch (e) {
    annotations = [];
  }
  if (activeCanvasId) {
    hydrateAnnotationsFromIndexedDb(activeCanvasId, storageHydrationToken, { preferIndexedDb: true });
  }
}

function formatAnnotationTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function escapeHtml(text) {
  return String(text || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function createAnnotationAt(x, y) {
  activeAnnotationDraftId = `anno_${Date.now()}`;
  annotations.push({
    id: activeAnnotationDraftId,
    x,
    y,
    text: '',
    author: 'lihua',
    createdAt: new Date().toISOString(),
    collapsed: false,
    draft: true
  });
  saveAnnotations('新建批注');
  renderBoard();
  requestAnimationFrame(() => {
    const input = document.querySelector(`[data-annotation-input="${activeAnnotationDraftId}"]`);
    if (input) input.focus();
  });
}

function commitAnnotation(id, text) {
  const annotation = annotations.find(a => a.id === id);
  if (!annotation) return;
  const value = text.trim();
  if (!value) {
    annotations = annotations.filter(a => a.id !== id);
  } else {
    annotation.text = value;
    annotation.draft = false;
    annotation.collapsed = false;
    annotation.updatedAt = new Date().toISOString();
  }
  if (activeAnnotationDraftId === id) activeAnnotationDraftId = null;
  saveAnnotations(value ? '保存批注' : '取消批注');
  renderBoard();
}

function deleteAnnotation(id) {
  annotations = annotations.filter(a => a.id !== id);
  if (activeAnnotationDraftId === id) activeAnnotationDraftId = null;
  saveAnnotations('删除批注');
  renderBoard();
}

function setAnnotationCollapsed(id, collapsed) {
  const annotation = annotations.find(a => a.id === id);
  if (!annotation) return;
  annotation.collapsed = collapsed;
  annotation.draft = false;
  saveAnnotations(collapsed ? '收起批注' : '展开批注');
  renderBoard();
}

function renderAnnotations() {
  if (!annotationsContainer) return;
  annotationsContainer.innerHTML = '';
  annotations.forEach(annotation => createAnnotationDOM(annotation));
}

function createAnnotationDOM(annotation) {
  const wrap = document.createElement('div');
  wrap.className = `annotation${annotation.collapsed ? ' collapsed' : ''}${annotation.draft ? ' draft' : ''}`;
  wrap.style.left = `${annotation.x}px`;
  wrap.style.top = `${annotation.y}px`;
  wrap.dataset.annotationId = annotation.id;
  wrap.addEventListener('mousedown', e => e.stopPropagation());
  wrap.addEventListener('click', e => e.stopPropagation());

  const anchor = document.createElement('div');
  anchor.className = 'annotation-anchor';
  wrap.appendChild(anchor);

  if (annotation.collapsed && !annotation.draft) {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'annotation-pin';
    pin.textContent = (annotation.author || 'L').slice(0, 1).toUpperCase();
    pin.title = '展开批注';
    pin.addEventListener('click', () => setAnnotationCollapsed(annotation.id, false));
    wrap.appendChild(pin);
    annotationsContainer.appendChild(wrap);
    return;
  }

  const line = document.createElement('div');
  line.className = 'annotation-line';
  wrap.appendChild(line);

  const panel = document.createElement('div');
  panel.className = annotation.draft ? 'annotation-compose' : 'annotation-card';

  if (annotation.draft) {
    panel.innerHTML = `
      <button class="annotation-emoji" type="button">☺</button>
      <input class="annotation-input" data-annotation-input="${annotation.id}" placeholder="写批注..." value="${escapeHtml(annotation.text || '')}">
      <button class="annotation-cancel" type="button">×</button>
      <button class="annotation-send" type="button">➤</button>
    `;
    const input = panel.querySelector('.annotation-input');
    const submit = () => commitAnnotation(annotation.id, input.value);
    panel.querySelector('.annotation-send').addEventListener('click', submit);
    panel.querySelector('.annotation-cancel').addEventListener('click', () => commitAnnotation(annotation.id, ''));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        commitAnnotation(annotation.id, '');
      }
    });
  } else {
    panel.innerHTML = `
      <div class="annotation-card-toolbar">
        <button class="annotation-collapse-btn" type="button" title="收起">‹</button>
        <span class="annotation-color-swatch"></span>
        <button class="annotation-delete-btn" type="button" title="删除">×</button>
      </div>
      <div class="annotation-card-body">
        <div class="annotation-avatar">${escapeHtml((annotation.author || 'L').slice(0, 1).toUpperCase())}</div>
        <div class="annotation-main">
          <div class="annotation-meta">
            <strong>${escapeHtml(annotation.author || 'lihua')}</strong>
            <span>${escapeHtml(formatAnnotationTime(annotation.createdAt))}</span>
          </div>
          <div class="annotation-text">${escapeHtml(annotation.text)}</div>
        </div>
      </div>
      <div class="annotation-card-reply">
        <span>☺</span>
        <input placeholder="使用 @ 提及其他人" disabled>
        <span>➤</span>
      </div>
    `;
    panel.querySelector('.annotation-collapse-btn').addEventListener('click', () => setAnnotationCollapsed(annotation.id, true));
    panel.querySelector('.annotation-delete-btn').addEventListener('click', () => deleteAnnotation(annotation.id));
  }

  wrap.appendChild(panel);
  annotationsContainer.appendChild(wrap);
}

function applyNodeDepthTransform(node, el = document.getElementById(node.id)) {
  if (!el) return;
  el.style.transform = viewMode === '3d'
    ? `translate3d(0px, 0px, ${node.z || 0}px)`
    : '';
}

function syncCardDepthTransforms() {
  nodes.forEach(node => applyNodeDepthTransform(node));
}

// Switch between the normal (tall) card layout and the wide/flat layout.
function setCardLayout(mode) {
  if (mode !== 'wide') mode = 'normal';
  cardLayout = mode;
  document.body.classList.toggle('wide-card-mode', mode === 'wide');
  try { localStorage.setItem('mindchat_card_layout', mode); } catch (e) {}

  renderBoard(); // re-render so cards pick up the new width/clamp
  if (mode === 'wide') {
    arrangeVertical(); // re-stack existing cards top-to-bottom
    if (nodes.length > 0) focusOnNode(nodes[0].id); // bring the new stack into view
  } else {
    drawAllConnections();
  }
}

// Flatten the node tree into conversation order (DFS from each root).
function nodesInTreeOrder() {
  const childrenOf = {};
  nodes.forEach(n => {
    const key = n.parentId || '__root__';
    (childrenOf[key] = childrenOf[key] || []).push(n);
  });
  const out = [];
  const visited = new Set();
  const walk = (node) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    out.push(node);
    (childrenOf[node.id] || []).forEach(walk);
  };
  nodes.filter(n => !n.parentId || !nodes.find(p => p.id === n.parentId)).forEach(walk);
  nodes.forEach(n => { if (!visited.has(n.id)) walk(n); });
  return out;
}

// Stack every card top-to-bottom following the parent -> child tree order.
// Used by the wide layout, where cards read better as a vertical feed.
function arrangeVertical() {
  const gap = 40;
  const baseX = 25000 - getCardWidth() / 2;
  let cursorY = 24000;
  nodesInTreeOrder().forEach(node => {
    const el = document.getElementById(node.id);
    const h = el ? el.offsetHeight : 120;
    node.x = baseX;
    node.y = cursorY;
    if (el) {
      el.style.left = `${node.x}px`;
      el.style.top = `${node.y}px`;
    }
    cursorY += h + gap;
  });
  saveBoard('切换宽卡片布局');
  drawAllConnections();
}

// Tidy left-to-right tree layout of the canvas cards: each subtree reserves its
// own vertical band so cards never overlap, columns are spaced by depth, and a
// parent is centered against its children. Heights are measured from the DOM.
function autoArrangeCanvas() {
  const H_GAP = 120;          // gap between depth columns
  const V_GAP = 36;           // gap between sibling subtrees
  const cardWidth = getCardWidth();
  const startX = 24000, startY = 24000;

  const heightOf = (id) => {
    const el = document.getElementById(id);
    return el ? el.offsetHeight : 200;
  };
  const childrenOf = (id) => nodes.filter(n => n.parentId === id);
  const roots = nodes.filter(n => !n.parentId || !nodes.find(p => p.id === n.parentId));

  // Pass 1: vertical span required by each subtree.
  const subH = {};
  const calcH = (node, seen) => {
    if (seen.has(node.id)) return 0;
    seen.add(node.id);
    const own = heightOf(node.id);
    const kids = childrenOf(node.id);
    if (kids.length === 0) { subH[node.id] = own; return own; }
    let total = 0;
    kids.forEach((k, i) => { total += calcH(k, seen); if (i < kids.length - 1) total += V_GAP; });
    subH[node.id] = Math.max(own, total);
    return subH[node.id];
  };
  roots.forEach(r => calcH(r, new Set()));

  // Pass 2: assign x by depth, y by centering within the reserved band.
  const placed = new Set();
  const place = (node, depth, bandTop) => {
    if (placed.has(node.id)) return;
    placed.add(node.id);
    const own = heightOf(node.id);
    node.x = startX + depth * (cardWidth + H_GAP);
    const kids = childrenOf(node.id);
    if (kids.length === 0) {
      node.y = bandTop;
    } else {
      const total = kids.reduce((s, k, i) => s + subH[k.id] + (i < kids.length - 1 ? V_GAP : 0), 0);
      let cursor = bandTop + Math.max(0, (subH[node.id] - total) / 2);
      kids.forEach(k => { place(k, depth + 1, cursor); cursor += subH[k.id] + V_GAP; });
      const cFirst = kids[0].y + heightOf(kids[0].id) / 2;
      const cLast = kids[kids.length - 1].y + heightOf(kids[kids.length - 1].id) / 2;
      node.y = (cFirst + cLast) / 2 - own / 2;
    }
  };
  let band = startY;
  roots.forEach(r => { place(r, 0, band); band += subH[r.id] + V_GAP * 2; });

  nodes.forEach(n => {
    const el = document.getElementById(n.id);
    if (el) { el.style.left = `${n.x}px`; el.style.top = `${n.y}px`; }
  });
  saveBoard('自动排列卡片');
  drawAllConnections();
  fitNodesInViewport(nodes, { maxScale: 0.85, minScale: 0.12, padding: 140 });
}

// ---- Chat view: render the conversation as a scrollable chat interface ----
// The implementation lives in scripts/chat.js. app.js keeps only the shared
// state bridge so the rest of the legacy single-file app can call chat features
// while we gradually split other areas into modules.
let chatMode = false;
const chatModule = window.MindChatModules.createChatModule({
  nodes: () => nodes,
  currentLang: () => currentLang,
  translations: () => translations,
  treeMode: () => treeMode,
  setTreeModeValue: (value) => { treeMode = value; },
  setChatModeValue: (value) => { chatMode = value; },
  setCommentMode,
  getCardWidth,
  getNodeRenderedWidth,
  getNodeRenderedHeight,
  rememberActiveNode,
  setSelectedNodeIds: (ids) => { selectedNodeIds = ids; },
  saveBoard,
  renderBoard,
  triggerAI,
  renderMarkdown,
  locateOnCanvas,
  followUpFromChat
});

function setChatMode(on) {
  chatModule.setChatMode(on);
}

function renderChatView() {
  chatModule.renderChatView();
}

function chatBranchLabel(branchNode) {
  return chatModule.chatBranchLabel(branchNode);
}
// ---- Tree view: collapsible tree + "list by conversation" sub-mode ----
let treeMode = false;
let treeSubMode = 'tree'; // 'tree' | 'convos'
const treeHidden = new Set(); // node ids whose branch (subtree, incl. itself) is collapsed away

function setTreeSubMode(mode) {
  treeSubMode = (mode === 'convos') ? 'convos' : 'tree';
  convoPanelOpen = false;
  convoNewDraft = false;
  document.body.classList.remove('tree-convo-panel-open');
  const tb = document.getElementById('tree-sub-tree');
  const cb = document.getElementById('tree-sub-convos');
  const nb = document.getElementById('tree-new-chat');
  if (tb) tb.classList.toggle('active', treeSubMode === 'tree');
  if (cb) cb.classList.toggle('active', treeSubMode === 'convos');
  if (nb) nb.classList.toggle('hidden', treeSubMode !== 'convos');
  renderTreeView();
}

function setTreeMode(on) {
  treeMode = !!on;
  if (!treeMode) document.body.classList.remove('tree-convo-panel-open');
  if (treeMode) setCommentMode(false);
  if (treeMode && chatMode) {
    // overlays are mutually exclusive
    chatMode = false;
    document.body.classList.remove('chat-mode');
    const cb = document.getElementById('chat-mode-btn');
    if (cb) cb.classList.remove('active');
    try { localStorage.setItem('mindchat_chat_mode', '0'); } catch (e) {}
  }
  document.body.classList.toggle('tree-mode', treeMode);
  const btn = document.getElementById('tree-mode-btn');
  if (btn) btn.classList.toggle('active', treeMode);
  const nb = document.getElementById('tree-new-chat');
  if (nb) nb.classList.toggle('hidden', !treeMode || treeSubMode !== 'convos');
  if (treeMode) renderTreeView();
}

function treeRealVisibleChildren(realId) {
  return nodes.filter(n => n.parentId === realId && !treeHidden.has(n.id));
}
function treeRealChildren(realId) {
  return nodes.filter(n => n.parentId === realId);
}

function renderTreeView() {
  const inner = document.getElementById('tree-inner');
  if (!inner) return;

  const countEl = document.getElementById('tree-convo-count');
  if (treeSubMode === 'convos') {
    renderTreeConversations(inner, countEl);
    return;
  }
  if (countEl) countEl.textContent = '';

  inner.innerHTML = '';

  const realRoots = nodes.filter(n => !n.parentId || !nodes.find(p => p.id === n.parentId));
  if (realRoots.length === 0) {
    inner.innerHTML = `<div class="chat-empty">${currentLang === 'zh' ? '当前画布暂无消息' : 'No messages on this canvas'}</div>`;
    inner.style.width = '';
    inner.style.height = '';
    return;
  }

  // Build a virtual tree: a dialogue card splits into a question node and an
  // answer node (answer is the question's child); real children hang off the
  // answer. Non-dialogue cards stay a single node.
  const vNodes = {};      // vid -> { role, full, realId, isLoading }
  const vChildren = {};   // vid -> [childVid]
  const headOf = {};      // realId -> vid where the incoming edge lands
  const tailOf = {};      // realId -> vid where real children attach
  const mkV = (id, role, full, realId, isLoading) => {
    vNodes[id] = { role, full: (full || '').replace(/\s+/g, ' ').trim(), realId, isLoading };
    vChildren[id] = [];
    return id;
  };
  nodes.forEach(node => {
    const isDialogue = node.question !== undefined || node.role === 'dialogue';
    if (isDialogue) {
      const q = mkV(node.id + '::q', 'user', node.question, node.id, false);
      const a = mkV(node.id + '::a', 'assistant', node.content, node.id, node.isLoading);
      vChildren[q].push(a);
      headOf[node.id] = q;
      tailOf[node.id] = a;
    } else {
      const v = mkV(node.id, node.role === 'user' ? 'user' : 'assistant', node.content, node.id, node.isLoading);
      headOf[node.id] = v;
      tailOf[node.id] = v;
    }
  });
  nodes.forEach(node => {
    if (node.parentId && nodes.find(n => n.id === node.parentId)) {
      vChildren[tailOf[node.parentId]].push(headOf[node.id]);
    }
  });

  // Visible children of a virtual node: the internal question->answer edge is
  // always shown; a real branch edge is hidden when its card is collapsed.
  const visKids = (vid) => vChildren[vid].filter(cid =>
    vNodes[cid].realId === vNodes[vid].realId || !treeHidden.has(vNodes[cid].realId));

  const roots = realRoots.map(r => headOf[r.id]);

  const COL_W = 250, ROW_H = 64, NODE_W = 200, NODE_H = 44, PAD = 40;
  const pos = {};
  let row = 0;
  const layout = (vid, depth) => {
    const kids = visKids(vid);
    const x = PAD + depth * COL_W;
    if (kids.length === 0) {
      pos[vid] = { x, y: PAD + row * ROW_H };
      row++;
    } else {
      kids.forEach(k => layout(k, depth + 1));
      const ys = kids.map(k => pos[k].y);
      pos[vid] = { x, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    }
  };
  roots.forEach(r => layout(r, 0));

  let maxX = 0, maxY = 0;
  Object.values(pos).forEach(p => { maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
  const contentW = maxX + NODE_W + PAD;
  const contentH = maxY + NODE_H + PAD;

  // Center the tree in the viewport when it is smaller than the visible area;
  // otherwise keep the natural top-left origin and let the container scroll.
  const viewEl = inner.parentElement;
  const viewW = viewEl ? viewEl.clientWidth : contentW;
  const viewH = viewEl ? viewEl.clientHeight : contentH;
  const xOff = Math.max(0, (viewW - contentW) / 2);
  const yOff = Math.max(0, (viewH - contentH) / 2);
  if (xOff || yOff) {
    Object.values(pos).forEach(p => { p.x += xOff; p.y += yOff; });
  }

  const width = Math.max(contentW, viewW);
  const height = Math.max(contentH, viewH);
  inner.style.width = `${width}px`;
  inner.style.height = `${height}px`;

  // Connectors
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'tree-svg');
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  inner.appendChild(svg);

  const edgeSeen = new Set();
  const drawEdges = (vid) => {
    if (edgeSeen.has(vid)) return;
    edgeSeen.add(vid);
    const p = pos[vid];
    visKids(vid).forEach(cid => {
      const c = pos[cid];
      const x1 = p.x + NODE_W, y1 = p.y + NODE_H / 2;
      const x2 = c.x, y2 = c.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
      path.setAttribute('class', 'tree-edge');
      svg.appendChild(path);
      drawEdges(cid);
    });
  };
  roots.forEach(drawEdges);

  // Node boxes
  const nodeSeen = new Set();
  const drawNode = (vid) => {
    if (nodeSeen.has(vid)) return;
    nodeSeen.add(vid);
    const v = vNodes[vid];
    const realNode = nodes.find(n => n.id === v.realId);
    const p = pos[vid];

    const box = document.createElement('div');
    box.className = `tree-node tree-role-${v.role}`;
    box.style.left = `${p.x}px`;
    box.style.top = `${p.y}px`;
    box.style.width = `${NODE_W}px`;

    const icon = v.role === 'user' ? '👤' : '🤖';
    const full = v.full || (v.isLoading ? '…' : '');
    box.title = full;
    const label = document.createElement('div');
    label.className = 'tree-node-label';
    const textSpan = document.createElement('span');
    textSpan.className = 'tree-node-text';
    textSpan.textContent = full.length > 28 ? full.slice(0, 28) + '…' : full;
    label.innerHTML = `<span class="tree-node-icon">${icon}</span>`;
    label.appendChild(textSpan);
    box.appendChild(label);

    // Jump to this card on the canvas when clicking the node body.
    box.addEventListener('click', (e) => {
      if (e.target.closest('.tree-collapse, .tree-branch-x')) return;
      setTreeMode(false);
      centerOnNode(v.realId);
    });

    // Collapse-all / expand-all toggle: only on a card's tail node (where its
    // real children attach), when it actually has real children.
    const isTail = tailOf[v.realId] === vid;
    const realKids = isTail ? treeRealChildren(v.realId) : [];
    if (realKids.length > 0) {
      const hiddenKids = realKids.filter(k => treeHidden.has(k.id));
      const tog = document.createElement('button');
      tog.className = 'tree-collapse';
      if (hiddenKids.length > 0) {
        tog.textContent = `+${hiddenKids.length}`;
        tog.title = currentLang === 'zh' ? '展开全部分支' : 'Expand all branches';
        tog.addEventListener('click', (e) => {
          e.stopPropagation();
          realKids.forEach(k => treeHidden.delete(k.id));
          renderTreeView();
        });
      } else {
        tog.textContent = '−';
        tog.title = currentLang === 'zh' ? '收回所有分支' : 'Collapse all branches';
        tog.addEventListener('click', (e) => {
          e.stopPropagation();
          realKids.forEach(k => treeHidden.add(k.id));
          renderTreeView();
        });
      }
      box.appendChild(tog);
    }

    // Per-branch handle: on a card's head node, collapse just this branch when
    // its parent card forks (>= 2 visible branches).
    const isHead = headOf[v.realId] === vid;
    if (isHead && realNode && realNode.parentId &&
        treeRealVisibleChildren(realNode.parentId).length >= 2) {
      const x = document.createElement('button');
      x.className = 'tree-branch-x';
      x.textContent = '×';
      x.title = currentLang === 'zh' ? '收回此分支' : 'Collapse this branch';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        treeHidden.add(v.realId);
        renderTreeView();
      });
      box.appendChild(x);
    }

    inner.appendChild(box);
    visKids(vid).forEach(drawNode);
  };
  roots.forEach(drawNode);
}

// "List by conversation": enumerate each independent root->leaf conversation and
// render it as its own horizontal lane (mock B). Click a lane to read it fullscreen.
function treeConversations() {
  const leaves = nodes.filter(n => !nodes.some(c => c.parentId === n.id));
  return leaves.map(leaf => {
    const path = [];
    const seen = new Set();
    let cur = leaf;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.unshift(cur);
      cur = nodes.find(n => n.id === cur.parentId);
    }
    return { leaf, path };
  });
}

function renderTreeConversations(inner, countEl) {
  inner.style.width = '';
  inner.style.height = convoPanelOpen ? '100%' : '';
  inner.innerHTML = '';

  const convos = treeConversations();
  if (countEl) {
    countEl.textContent = currentLang === 'zh'
      ? `共 ${convos.length} 条独立对话`
      : `${convos.length} separate conversations`;
  }
  if (convoPanelOpen) {
    convoPreviewList = convos;
    if (convoNewDraft) {
      renderConvoNewDraft();
    } else if (convos.length > 0) {
      renderConvoPreview(Math.min(convoPreviewIdx, convos.length - 1));
    }
    return;
  }
  if (convos.length === 0) {
    inner.innerHTML = `<div class="chat-empty">${currentLang === 'zh' ? '当前画布暂无消息' : 'No messages on this canvas'}</div>`;
    return;
  }

  const list = document.createElement('div');
  list.className = 'tconvo-list';

  convos.forEach((c, i) => {
    const lane = document.createElement('div');
    lane.className = 'tconvo-lane';
    lane.addEventListener('click', () => openConvoPreview(convos, i));

    const label = document.createElement('div');
    label.className = 'tconvo-label';
    label.textContent = `${currentLang === 'zh' ? '对话' : 'Conversation'} ${i + 1} · ${chatBranchLabel(c.leaf)}`;
    lane.appendChild(label);

    const badge = document.createElement('div');
    badge.className = 'tconvo-badge';
    badge.textContent = i + 1;
    lane.appendChild(badge);

    const chain = document.createElement('div');
    chain.className = 'tconvo-chain';
    c.path.forEach((node, j) => {
      const isDlg = node.question !== undefined || node.role === 'dialogue';
      const icon = isDlg ? '💬' : (node.role === 'user' ? '👤' : '🤖');
      const text = (node.question || node.content || '').replace(/\s+/g, ' ').trim() ||
        (node.isLoading ? '…' : '');
      const tn = document.createElement('div');
      tn.className = 'tconvo-node';
      const r = document.createElement('div');
      r.className = 'tconvo-node-r';
      r.textContent = icon;
      const t = document.createElement('div');
      t.className = 'tconvo-node-t';
      t.textContent = text.length > 22 ? text.slice(0, 22) + '…' : text;
      tn.appendChild(r);
      tn.appendChild(t);
      chain.appendChild(tn);
      if (j < c.path.length - 1) {
        const conn = document.createElement('div');
        conn.className = 'tconvo-conn';
        chain.appendChild(conn);
      }
    });
    lane.appendChild(chain);
    list.appendChild(lane);
  });

  inner.appendChild(list);
}

// Fullscreen preview of one whole conversation, with prev/next navigation.
let convoPreviewList = [];
let convoPreviewIdx = 0;
let convoFollowText = '';
let convoNewDraft = false;
let convoPanelOpen = false;

function openConvoPreview(list, i) {
  convoPreviewList = list;
  convoNewDraft = false;
  convoPanelOpen = true;
  document.body.classList.add('tree-convo-panel-open');
  renderConvoPreview(i);
}

function closeConvoPreview() {
  convoPanelOpen = false;
  convoNewDraft = false;
  convoFollowText = '';
  document.body.classList.remove('tree-convo-panel-open');
  renderTreeView();
}

function convoPreviewStep(d) {
  if (!convoPanelOpen || convoPreviewList.length === 0 || convoNewDraft) return;
  renderConvoPreview((convoPreviewIdx + d + convoPreviewList.length) % convoPreviewList.length);
}

function refreshConvoPreviewForNode(nodeId) {
  if (!treeMode || treeSubMode !== 'convos' || !convoPanelOpen) return;

  const updated = treeConversations();
  const idx = updated.findIndex(c => c.path.some(n => n.id === nodeId));
  convoPreviewList = updated;
  renderConvoPreview(idx >= 0 ? idx : Math.min(convoPreviewIdx, updated.length - 1));
}

function ensureConvoPanel() {
  const inner = document.getElementById('tree-inner');
  if (!inner) return false;

  inner.style.width = '';
  inner.style.height = '100%';
  inner.innerHTML = '';

  const panel = document.createElement('div');
  panel.className = 'cp-inner cp-inline';
  panel.innerHTML = `
    <div class="cp-header">
      <button class="cp-back" id="cp-back" type="button">\u2039 ${currentLang === 'zh' ? '\u8fd4\u56de\u5217\u8868' : 'Back'}</button>
      <div class="cp-nav">
        <button class="cp-navbtn" id="cp-prev" type="button">\u2039</button>
        <span class="cp-count" id="cp-count"></span>
        <button class="cp-navbtn" id="cp-next" type="button">\u203a</button>
      </div>
      <div class="cp-title" id="cp-title"></div>
    </div>
    <div class="cp-body" id="cp-body"></div>
    <div class="cp-composer">
      <textarea id="cp-follow-input" class="cp-follow-input" rows="1"></textarea>
      <button id="cp-follow-send" class="cp-follow-send" title="${currentLang === 'zh' ? '\u53d1\u9001' : 'Send'}" type="button">\u27a4</button>
    </div>`;
  inner.appendChild(panel);

  const back = document.getElementById('cp-back');
  const prev = document.getElementById('cp-prev');
  const next = document.getElementById('cp-next');
  const input = document.getElementById('cp-follow-input');
  const send = document.getElementById('cp-follow-send');

  if (back) back.addEventListener('click', closeConvoPreview);
  if (prev) prev.addEventListener('click', () => convoPreviewStep(-1));
  if (next) next.addEventListener('click', () => convoPreviewStep(1));
  if (send) send.addEventListener('click', submitConvoFollowUp);
  if (input) {
    input.addEventListener('input', () => {
      convoFollowText = input.value;
      input.style.height = 'auto';
      input.style.height = `${Math.min(150, input.scrollHeight)}px`;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitConvoFollowUp();
      }
    });
  }

  return true;
}

function startConvoNewConversation() {
  convoPanelOpen = true;
  convoNewDraft = true;
  convoFollowText = '';
  document.body.classList.add('tree-convo-panel-open');
  renderConvoNewDraft();
  requestAnimationFrame(() => {
    const input = document.getElementById('cp-follow-input');
    if (input) input.focus();
  });
}

function submitConvoFollowUp() {
  const c = convoPreviewList[convoPreviewIdx];
  const parent = convoNewDraft ? null : (c ? c.leaf : null);
  const text = String(convoFollowText || '').trim();
  if (!text || (!convoNewDraft && !parent)) return;

  const cardWidth = getCardWidth();
  const nodeId = `node_${Date.now()}_cp`;
  const position = parent
    ? { x: parent.x + cardWidth + 120, y: parent.y, z: parent.z || 0 }
    : getNextBlankCardPosition();
  const node = {
    id: nodeId,
    parentId: parent ? parent.id : null,
    role: 'dialogue',
    question: text,
    content: '',
    x: position.x,
    y: position.y,
    z: position.z || 0,
    isLoading: true,
    isFollowUp: !!parent,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  nodes.push(node);
  rememberActiveNode(node.id);
  selectedNodeIds = [node.id];
  convoFollowText = '';
  convoNewDraft = false;
  saveBoard(parent
    ? (currentLang === 'zh' ? '\u5bf9\u8bdd\u9884\u89c8\u8ffd\u95ee' : 'Conversation preview follow-up')
    : (currentLang === 'zh' ? '\u5bf9\u8bdd\u9884\u89c8\u65b0\u5bf9\u8bdd' : 'Conversation preview new chat'));
  renderBoard();

  const updated = treeConversations();
  const nextIdx = updated.findIndex(item => item.leaf.id === node.id);
  convoPreviewList = updated;
  renderConvoPreview(nextIdx >= 0 ? nextIdx : convoPreviewIdx);
  triggerAI(node.id, node.id);
}

function renderConvoNewDraft() {
  if (!ensureConvoPanel()) return;
  const count = document.getElementById('cp-count');
  const title = document.getElementById('cp-title');
  const body = document.getElementById('cp-body');
  if (count) count.textContent = currentLang === 'zh' ? '\u65b0\u5bf9\u8bdd' : 'New chat';
  if (title) title.textContent = currentLang === 'zh' ? '\u65b0\u5bf9\u8bdd' : 'New chat';
  if (body) {
    body.innerHTML = `<div class="chat-empty">${currentLang === 'zh' ? '\u8f93\u5165\u7b2c\u4e00\u53e5\u8bdd\uff0c\u5f00\u59cb\u4e00\u6bb5\u65b0\u5bf9\u8bdd' : 'Type the first message to start a new conversation'}</div>`;
    body.scrollTop = 0;
  }

  const input = document.getElementById('cp-follow-input');
  if (input) {
    input.placeholder = currentLang === 'zh' ? '\u5f00\u59cb\u4e00\u6bb5\u65b0\u5bf9\u8bdd...' : 'Start a new chat...';
    input.value = convoFollowText;
    input.style.height = 'auto';
    input.style.height = `${Math.min(150, input.scrollHeight)}px`;
  }
}

function renderConvoPreview(i) {
  if (!ensureConvoPanel()) return;
  convoNewDraft = false;
  convoPreviewIdx = i;
  const c = convoPreviewList[i];
  if (!c) return;
  const count = document.getElementById('cp-count');
  const title = document.getElementById('cp-title');
  const body = document.getElementById('cp-body');
  if (count) count.textContent = `${i + 1} / ${convoPreviewList.length}`;
  if (title) title.textContent = `${currentLang === 'zh' ? '整条会话' : 'Whole conversation'} · ${chatBranchLabel(c.leaf)}`;
  if (!body) return;
  body.innerHTML = '';

  const addBubble = (role, text) => {
    const row = document.createElement('div');
    row.className = `chat-msg chat-msg-${role}`;
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    const meta = document.createElement('div');
    meta.className = 'chat-msg-meta';
    const icon = role === 'user' ? '👤' : '🤖';
    const label = role === 'user' ? translations[currentLang].userRole : translations[currentLang].aiRole;
    meta.innerHTML = `<span class="role-icon">${icon}</span> ${label}`;
    const content = document.createElement('div');
    content.className = 'chat-msg-content';
    content.innerHTML = renderMarkdown(text && text.trim() ? text : '…');
    bubble.appendChild(meta);
    bubble.appendChild(content);
    row.appendChild(bubble);
    body.appendChild(row);
  };

  c.path.forEach(node => {
    const isDlg = node.question !== undefined || node.role === 'dialogue';
    if (isDlg) {
      if (node.question && node.question.trim()) addBubble('user', node.question);
      addBubble('assistant', node.content);
    } else {
      addBubble(node.role === 'user' ? 'user' : 'assistant', node.content);
    }
  });
  const input = document.getElementById('cp-follow-input');
  if (input) {
    input.placeholder = currentLang === 'zh' ? '\u7ee7\u7eed\u8ffd\u95ee...' : 'Ask a follow-up...';
    input.value = convoFollowText;
    input.style.height = 'auto';
    input.style.height = `${Math.min(150, input.scrollHeight)}px`;
  }
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
}

// Fullscreen reader for a card — useful when a card holds a lot of text.
let fullscreenSaveHandlers = [];

function applyMarkdownFormat(textarea, type) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const selected = value.slice(start, end);
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const before = value.slice(0, start);
  const after = value.slice(end);
  let insert = '';
  let cursorStart = start;
  let cursorEnd = start;

  const blockInsert = (prefix, placeholder) => {
    const text = selected || placeholder;
    const needsNewLine = start > 0 && value[start - 1] !== '\n';
    insert = `${needsNewLine ? '\n' : ''}${prefix}${text}`;
    cursorStart = start + (needsNewLine ? 1 : 0) + prefix.length;
    cursorEnd = cursorStart + text.length;
  };

  switch (type) {
    case 'h1':
      blockInsert('# ', '主标题');
      break;
    case 'h2':
      blockInsert('## ', '标题');
      break;
    case 'h3':
      blockInsert('### ', '小标题');
      break;
    case 'bold':
      insert = `**${selected || '重点'}**`;
      cursorStart = start + 2;
      cursorEnd = cursorStart + (selected || '重点').length;
      break;
    case 'quote':
      blockInsert('> ', '引用内容');
      break;
    case 'bullet':
      blockInsert('- ', '列表项');
      break;
    case 'number':
      blockInsert('1. ', '列表项');
      break;
    case 'code':
      insert = selected
        ? `\`\`\`\n${selected}\n\`\`\``
        : '```\n代码\n```';
      cursorStart = start + 4;
      cursorEnd = cursorStart + (selected || '代码').length;
      break;
    case 'divider':
      insert = `${start > 0 && value[start - 1] !== '\n' ? '\n' : ''}---\n`;
      cursorStart = cursorEnd = start + insert.length;
      break;
    default:
      return;
  }

  if (['h1', 'h2', 'h3', 'quote', 'bullet', 'number'].includes(type) && start !== lineStart && !selected) {
    insert = `\n${insert}`;
    cursorStart += 1;
    cursorEnd += 1;
  }

  textarea.value = `${before}${insert}${after}`;
  textarea.focus();
  textarea.setSelectionRange(cursorStart, cursorEnd);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function createMarkdownToolbar(textarea) {
  const toolbar = document.createElement('div');
  toolbar.className = 'cf-md-toolbar';
  const actions = [
    ['h1', 'H1', '一级标题'],
    ['h2', 'H2', '二级标题'],
    ['h3', 'H3', '三级标题'],
    ['bold', 'B', '加粗'],
    ['bullet', '•', '无序列表'],
    ['number', '1.', '有序列表'],
    ['quote', '>', '引用'],
    ['code', '</>', '代码块'],
    ['divider', '---', '分割线']
  ];

  actions.forEach(([type, label, title]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cf-md-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', () => applyMarkdownFormat(textarea, type));
    toolbar.appendChild(btn);
  });

  return toolbar;
}

function openCardFullscreen(node) {
  rememberActiveNode(node.id);
  const overlay = document.getElementById('card-fullscreen');
  const content = document.getElementById('cf-content');
  if (!overlay || !content) return;
  content.innerHTML = '';
  fullscreenSaveHandlers = [];

  let hasEditableBlock = false;

  const addBlock = (label, icon, text, roleType, editField = null, canEditBlock = null) => {
    const block = document.createElement('div');
    block.className = `cf-block cf-block-${roleType}`;
    const head = document.createElement('div');
    head.className = 'cf-role';
    head.textContent = `${icon} ${label}`;

    if (canEditBlock === null) {
      canEditBlock = editField === 'question' ? canEditNodeQuestion(node) : canEditNodeContent(node);
    }

    let body;
    let toolbar = null;
    if (canEditBlock && editField) {
      hasEditableBlock = true;
      body = document.createElement('textarea');
      body.className = 'cf-text cf-editor';
      body.value = text || '';
      const saveEdit = () => {
        const currentNode = nodes.find(n => n.id === node.id);
        if (!currentNode) return;
        currentNode[editField] = body.value;
        saveBoard('全屏编辑卡片');
      };
      fullscreenSaveHandlers.push(saveEdit);
      body.addEventListener('input', () => autoResizeTextarea(body));
      body.addEventListener('blur', saveEdit);
      requestAnimationFrame(() => autoResizeTextarea(body));
      toolbar = createMarkdownToolbar(body);
    } else {
      body = document.createElement('div');
      body.className = 'cf-text';
      body.innerHTML = renderMarkdown(text || '');
    }

    block.appendChild(head);
    if (toolbar) block.appendChild(toolbar);
    block.appendChild(body);
    content.appendChild(block);
  };

  const isDialogue = node.question !== undefined || node.role === 'dialogue';
  if (isDialogue) {
    if (node.question && node.question.trim()) addBlock(translations[currentLang].userRole, '👤', node.question, 'user', 'question');
    addBlock(translations[currentLang].aiRole, '🤖', node.content, 'assistant', 'content');
  } else {
    const isUser = node.role === 'user';
    addBlock(isUser ? translations[currentLang].userRole : translations[currentLang].aiRole,
      isUser ? '👤' : '🤖', node.content, isUser ? 'user' : 'assistant', 'content');
  }

  if (hasEditableBlock) {
    const hint = document.createElement('div');
    hint.className = 'cf-edit-hint';
    hint.textContent = '可在全屏中编辑，关闭时会同步到卡片';
    content.prepend(hint);
  }

  if (node.image) {
    const img = document.createElement('img');
    img.src = node.image;
    img.className = 'cf-image';
    content.appendChild(img);
  }

  overlay.classList.remove('hidden');
}

function closeCardFullscreen() {
  const overlay = document.getElementById('card-fullscreen');
  if (!overlay || overlay.classList.contains('hidden')) return;
  fullscreenSaveHandlers.forEach(save => save());
  fullscreenSaveHandlers = [];
  renderBoard();
  overlay.classList.add('hidden');
}

function clearCardSelection() {
  selectedNodeIds = [];
  document.querySelectorAll('.chat-card').forEach(c => c.classList.remove('selected'));
  updateCardSizePanel();
}

function setCardSelected(id, selected) {
  const el = document.getElementById(id);
  if (selected) {
    if (!selectedNodeIds.includes(id)) selectedNodeIds.push(id);
    if (el) el.classList.add('selected');
  } else {
    selectedNodeIds = selectedNodeIds.filter(nodeId => nodeId !== id);
    if (el) el.classList.remove('selected');
  }
}

function selectCardNode(id, options = {}) {
  const { additive = false, toggle = false } = options;
  const isSelected = selectedNodeIds.includes(id);

  if (toggle && isSelected) {
    setCardSelected(id, false);
  } else {
    if (!additive) clearCardSelection();
    setCardSelected(id, true);
    rememberActiveNode(id);
  }

  updateCardSizePanel();
}

function isCardSelectionIgnoredTarget(target) {
  return !!target.closest('button, a, input, textarea, select, .card-resize-handle, .copy-menu');
}

// Generate the card element in the DOM
function createCardDOM(node) {
  const card = document.createElement('div');
  card.id = node.id;
  
  // Set class name, maintaining selection visual state
  const isSelected = selectedNodeIds.includes(node.id);
  const isDialogue = node.question !== undefined || node.role === 'dialogue';
  const cardRole = isDialogue ? 'dialogue' : node.role;
  card.className = `chat-card role-${cardRole} new-card-anim${isSelected ? ' selected' : ''}`;
  card.style.left = `${node.x}px`;
  card.style.top = `${node.y}px`;
  // Apply a custom size if the user has resized this card.
  if (node.width) card.style.width = `${node.width}px`;
  if (node.height) {
    card.style.height = `${node.height}px`;
    card.classList.add('card-resized');
  }
  applyNodeDepthTransform(node, card);

  // Header (Drag handle)
  const header = document.createElement('div');
  header.className = 'card-header';
  
  const roleSpan = document.createElement('span');
  roleSpan.className = 'card-role';
  let roleIcon = '🤖';
  let roleLabel = '';
  if (isDialogue) {
    roleIcon = '💬';
    roleLabel = translations[currentLang].dialogueRole || (currentLang === 'zh' ? '对话' : 'Dialogue');
  } else if (node.role === 'user') {
    roleIcon = '👤';
    roleLabel = translations[currentLang].userRole;
  } else {
    roleIcon = '🤖';
    roleLabel = translations[currentLang].aiRole;
  }
  roleSpan.innerHTML = `<span class="role-icon">${roleIcon}</span> ${roleLabel}`;
  
  const actions = document.createElement('div');
  actions.className = 'card-actions';

  // Preview content button for non-dialogue cards
  if (!isDialogue) {
    const previewBtn = document.createElement('button');
    previewBtn.className = 'card-btn preview-btn';
    previewBtn.title = currentLang === 'zh' ? '预览内容' : 'Preview Content';
    previewBtn.innerHTML = '👁️';
    bindPreviewHover(previewBtn, () => node.content || '');
    actions.appendChild(previewBtn);
  }

  // Copy button: click copies the answer; long-press/right-click opens choices.
  const copyBtn = document.createElement('button');
  copyBtn.className = 'card-btn copy-btn';
  copyBtn.type = 'button';
  copyBtn.title = currentLang === 'zh'
    ? '\u70b9\u51fb\u590d\u5236 AI \u56de\u7b54\uff1b\u957f\u6309\u9009\u62e9\u590d\u5236\u8303\u56f4'
    : 'Click to copy AI reply; long-press for copy options';
  copyBtn.innerHTML = '&#128203;';
  bindCardCopyButton(copyBtn, node);
  actions.appendChild(copyBtn);

  // Fullscreen reader button
  const fsBtn = document.createElement('button');
  fsBtn.className = 'card-btn fullscreen-btn';
  fsBtn.title = currentLang === 'zh' ? '全屏查看' : 'Fullscreen';
  fsBtn.innerHTML = '⛶';
  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCardFullscreen(node);
  });
  actions.appendChild(fsBtn);

  // Delete card button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'card-btn delete-btn';
  deleteBtn.title = translations[currentLang].deleteCard;
  deleteBtn.innerHTML = '✕';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteNode(node.id);
  });
  
  actions.appendChild(deleteBtn);
  header.appendChild(roleSpan);
  header.appendChild(actions);

  // Body
  const body = document.createElement('div');
  body.className = 'card-body';

  if (isDialogue) {
    // Question Box
    const qBox = document.createElement('div');
    qBox.className = 'card-question-box';

    const qHeader = document.createElement('div');
    qHeader.className = 'card-question-header';
    qHeader.innerHTML = `<span class="role-icon">👤</span> <strong>${translations[currentLang].userRole}:</strong>`;
    
    const qPreviewBtn = document.createElement('button');
    qPreviewBtn.className = 'preview-trigger-btn';
    qPreviewBtn.innerHTML = '👁️';
    qPreviewBtn.title = currentLang === 'zh' ? '预览提问内容' : 'Preview Question';
    bindPreviewHover(qPreviewBtn, () => node.question || '');
    qHeader.appendChild(qPreviewBtn);

    const qDisplay = document.createElement('div');
    qDisplay.className = 'card-question-text';
    qDisplay.innerHTML = renderMarkdown(node.question || '');

    const qTextarea = document.createElement('textarea');
    qTextarea.className = 'card-textarea hidden';
    qTextarea.value = node.question || '';

    const canEditQuestion = canEditNodeQuestion(node);

    // Double click display to edit question
    qDisplay.addEventListener('dblclick', () => {
      if (!canEditQuestion || canvasMode === 'pan' || spaceHeld) return;
      qDisplay.classList.add('hidden');
      qTextarea.classList.remove('hidden');
      qTextarea.focus();
      autoResizeTextarea(qTextarea);
    });

    qTextarea.addEventListener('blur', () => {
      saveNodeQuestion(node.id, qTextarea.value);
    });

    qTextarea.addEventListener('input', () => {
      autoResizeTextarea(qTextarea);
    });

    qBox.appendChild(qHeader);
    qBox.appendChild(qDisplay);
    qBox.appendChild(qTextarea);

    if (node.image) {
      const qImgContainer = document.createElement('div');
      qImgContainer.className = 'card-image-container';
      qImgContainer.style.position = 'relative';
      qImgContainer.style.marginTop = '8px';
      qImgContainer.style.borderRadius = '6px';
      qImgContainer.style.overflow = 'hidden';
      qImgContainer.style.border = '1px solid rgba(255, 255, 255, 0.1)';
      
      const qImg = document.createElement('img');
      qImg.src = node.image;
      qImg.style.width = '100%';
      qImg.style.display = 'block';
      qImgContainer.appendChild(qImg);
      
      // If it's a leaf dialogue card (no children), add the remove image button
      const hasChildren = nodes.some(n => n.parentId === node.id);
      if (!hasChildren) {
        const removeImgBtn = document.createElement('button');
        removeImgBtn.className = 'remove-image-btn';
        removeImgBtn.innerHTML = '✕';
        removeImgBtn.title = currentLang === 'zh' ? '移除图片' : 'Remove Image';
        removeImgBtn.style.position = 'absolute';
        removeImgBtn.style.top = '4px';
        removeImgBtn.style.right = '4px';
        removeImgBtn.style.background = 'rgba(0, 0, 0, 0.6)';
        removeImgBtn.style.color = '#fff';
        removeImgBtn.style.border = 'none';
        removeImgBtn.style.borderRadius = '50%';
        removeImgBtn.style.width = '20px';
        removeImgBtn.style.height = '20px';
        removeImgBtn.style.cursor = 'pointer';
        removeImgBtn.style.display = 'flex';
        removeImgBtn.style.alignItems = 'center';
        removeImgBtn.style.justifyContent = 'center';
        removeImgBtn.style.fontSize = '10px';
        removeImgBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          node.image = undefined;
          node.imageName = undefined;
          saveBoard('移除附件');
          renderBoard();
        });
        qImgContainer.appendChild(removeImgBtn);
      }
      
      qBox.appendChild(qImgContainer);
    }

    body.appendChild(qBox);

    // Divider
    const divider = document.createElement('div');
    divider.className = 'card-divider';
    body.appendChild(divider);

    // Reply Header
    const rHeader = document.createElement('div');
    rHeader.className = 'card-reply-header';
    rHeader.innerHTML = `<span class="role-icon">🤖</span> <strong>${translations[currentLang].aiRole}:</strong>`;
    
    const rPreviewBtn = document.createElement('button');
    rPreviewBtn.className = 'preview-trigger-btn';
    rPreviewBtn.innerHTML = '👁️';
    rPreviewBtn.title = currentLang === 'zh' ? '预览回答内容' : 'Preview Reply';
    bindPreviewHover(rPreviewBtn, () => node.content || '');
    rHeader.appendChild(rPreviewBtn);
    
    body.appendChild(rHeader);
  }

  // Reply Text display and textarea (used for both normal card content and combined card AI reply)
  const display = document.createElement('div');
  display.className = 'card-text-display';
  display.innerHTML = renderMarkdown(node.content || '');
  
  const textarea = document.createElement('textarea');
  textarea.className = 'card-textarea hidden';
  textarea.value = node.content || '';

  const canEditContent = canEditNodeContent(node);

  // Double click display to edit
  display.addEventListener('dblclick', () => {
    if (!canEditContent || canvasMode === 'pan' || spaceHeld) return;
    display.classList.add('hidden');
    textarea.classList.remove('hidden');
    textarea.focus();
    autoResizeTextarea(textarea);
  });

  textarea.addEventListener('blur', () => {
    saveNodeContent(node.id, textarea.value);
  });

  textarea.addEventListener('input', () => {
    autoResizeTextarea(textarea);
  });

  body.appendChild(display);
  body.appendChild(textarea);

  if (node.image) {
    const imgContainer = document.createElement('div');
    imgContainer.className = 'card-image-container';
    imgContainer.style.position = 'relative';
    imgContainer.style.marginTop = '8px';
    imgContainer.style.marginBottom = '8px';
    imgContainer.style.borderRadius = '6px';
    imgContainer.style.overflow = 'hidden';
    imgContainer.style.border = '1px solid rgba(255, 255, 255, 0.1)';

    const img = document.createElement('img');
    img.src = node.image;
    img.style.width = '100%';
    img.style.display = 'block';
    
    if (node.role === 'user') {
      const removeImgBtn = document.createElement('button');
      removeImgBtn.className = 'remove-image-btn';
      removeImgBtn.innerHTML = '✕';
      removeImgBtn.title = currentLang === 'zh' ? '移除图片' : 'Remove Image';
      removeImgBtn.style.position = 'absolute';
      removeImgBtn.style.top = '4px';
      removeImgBtn.style.right = '4px';
      removeImgBtn.style.background = 'rgba(0, 0, 0, 0.6)';
      removeImgBtn.style.color = '#fff';
      removeImgBtn.style.border = 'none';
      removeImgBtn.style.borderRadius = '50%';
      removeImgBtn.style.width = '20px';
      removeImgBtn.style.height = '20px';
      removeImgBtn.style.cursor = 'pointer';
      removeImgBtn.style.display = 'flex';
      removeImgBtn.style.alignItems = 'center';
      removeImgBtn.style.justifyContent = 'center';
      removeImgBtn.style.fontSize = '10px';
      removeImgBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        node.image = undefined;
        node.imageName = undefined;
        saveBoard('移除附件');
        renderBoard();
      });
      imgContainer.appendChild(removeImgBtn);
    }
    
    imgContainer.appendChild(img);
    body.appendChild(imgContainer);
  }

  if (node.isLoading) {
    const loader = document.createElement('div');
    loader.className = 'ai-typing-indicator';
    loader.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(loader);
    display.classList.add('hidden');
  }

  // Footer
  const footer = document.createElement('div');
  footer.className = 'card-footer';

  const time = document.createElement('span');
  time.className = 'card-time';
  time.innerText = node.timestamp || '';

  const actionsDiv = document.createElement('div');
  actionsDiv.style.display = 'flex';
  actionsDiv.style.flexWrap = 'wrap';
  actionsDiv.style.justifyContent = 'flex-end';
  actionsDiv.style.gap = '6px';

  // 1. Add "Attach File" button - allowed on all User cards and all Dialogue cards
  if (node.role === 'user' || isDialogue) {
    const attachBtn = document.createElement('button');
    attachBtn.className = 'card-action-trigger';
    attachBtn.innerHTML = '📎 ' + (currentLang === 'zh' ? '附件' : 'Attach');
    attachBtn.title = currentLang === 'zh' ? '上传图片、文本或表格文件' : 'Upload image, text, or CSV table';
    attachBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerCardFileUpload(node.id);
    });
    actionsDiv.appendChild(attachBtn);
  }

  // 2. Add AI Response / Regeneration buttons
  const hasChildren = nodes.some(n => n.parentId === node.id);
  if (node.role === 'user') {
    const respondBtn = document.createElement('button');
    respondBtn.className = 'card-action-trigger';
    respondBtn.innerHTML = translations[currentLang].aiRespond || (currentLang === 'zh' ? '🤖 让 AI 回答' : '🤖 Let AI Answer');
    respondBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerAIForUserNode(node.id);
    });
    actionsDiv.appendChild(respondBtn);
  } else if (isDialogue && !hasChildren) {
    const regenerateBtn = document.createElement('button');
    regenerateBtn.className = 'card-action-trigger';
    regenerateBtn.innerHTML = translations[currentLang].aiRegenerate || (currentLang === 'zh' ? '🔄 重新回答' : '🔄 Re-answer');
    regenerateBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      regenerateDialogueNode(node.id);
    });
    actionsDiv.appendChild(regenerateBtn);
  }

  if (isManualLinkableNote(node)) {
    const linkBtn = document.createElement('button');
    linkBtn.className = 'card-action-trigger';
    linkBtn.innerHTML = currentLang === 'zh' ? '\u2192 \u8fde\u63a5' : '\u2192 Link';
    linkBtn.title = currentLang === 'zh'
      ? '\u70b9\u51fb\u540e\u518d\u70b9\u53e6\u4e00\u5f20\u4fbf\u7b7e\uff0c\u628a\u5b83\u8fde\u5230\u8fd9\u5f20\u5361\u7247'
      : 'Click, then choose another note card to connect it to this card';
    linkBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (manualLinkSourceNodeId === node.id) cancelManualLinkMode();
      else startManualLinkMode(node.id);
    });
    actionsDiv.appendChild(linkBtn);

    if (node.parentId) {
      const unlinkBtn = document.createElement('button');
      unlinkBtn.className = 'card-action-trigger';
      unlinkBtn.innerHTML = currentLang === 'zh' ? '\u2715 \u65ad\u5f00' : '\u2715 Unlink';
      unlinkBtn.title = currentLang === 'zh'
        ? '\u65ad\u5f00\u8fd9\u5f20\u4fbf\u7b7e\u4e0e\u4e0a\u4e00\u5f20\u5361\u7247\u7684\u8fde\u63a5'
        : 'Disconnect this note from its parent card';
      unlinkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        manualDisconnectNoteCard(node.id);
      });
      actionsDiv.appendChild(unlinkBtn);
    }
  }

  const followUpBtn = document.createElement('button');
  followUpBtn.className = 'card-action-trigger';
  followUpBtn.innerHTML = translations[currentLang].followUp;
  followUpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    promptFollowUp(node.id);
  });
  actionsDiv.appendChild(followUpBtn);

  footer.appendChild(time);
  footer.appendChild(actionsDiv);

  card.appendChild(header);
  card.appendChild(body);
  card.appendChild(footer);

  card.addEventListener('click', (e) => {
    if (manualLinkSourceNodeId && !isCardSelectionIgnoredTarget(e.target)) {
      e.stopPropagation();
      if (node.id === manualLinkSourceNodeId) {
        cancelManualLinkMode();
        return;
      }
      if (canFinishManualLink(manualLinkSourceNodeId, node.id)) {
        if (manualConnectNoteCards(manualLinkSourceNodeId, node.id)) {
          cancelManualLinkMode();
        }
      } else {
        alert(currentLang === 'zh'
          ? '\u53ea\u80fd\u70b9\u51fb\u53e6\u4e00\u5f20\u6ca1\u6709 AI \u56de\u7b54\u7684\u4fbf\u7b7e\u5361\u6765\u5b8c\u6210\u8fde\u63a5\u3002'
          : 'Click another note card without an AI reply to finish the link.');
      }
      return;
    }
    if (e.target.closest('.card-header')) return;
    if (isCardSelectionIgnoredTarget(e.target)) return;
    selectCardNode(node.id, { additive: e.shiftKey, toggle: e.shiftKey });
  });

  // Setup dragging handlers for this specific card
  header.addEventListener('mousedown', (e) => {
    if (e.target.closest('.card-btn')) return; // Avoid drag on delete click
    if (manualLinkSourceNodeId) return;
    if (canvasMode === 'pan' || spaceHeld) return;
    e.preventDefault();
    selectCardNode(node.id, { additive: e.shiftKey, toggle: e.shiftKey });

    draggedNode = node;
    nodeDragStartX = e.clientX;
    nodeDragStartY = e.clientY;
    
    // Store dragStart coordinates for all currently selected nodes
    selectedNodeIds.forEach(id => {
      const n = nodes.find(item => item.id === id);
      if (n) {
        n.dragStartX = n.x;
        n.dragStartY = n.y;
        n.dragStartZ = n.z || 0;
      }
    });

    document.addEventListener('mousemove', onNodeMouseMove);
    document.addEventListener('mouseup', onNodeMouseUp);
  });

  // Double-click a non-editable part of the card to read it fullscreen.
  // (Double-clicking the text itself keeps editing it.)
  card.addEventListener('dblclick', (e) => {
    if (e.target.closest('.card-text-display, .card-question-text, .card-textarea, textarea, input, button, a, img, .card-resize-handle')) {
      return;
    }
    openCardFullscreen(node);
  });

  // Resize handle (bottom-right corner) — drag to change card width/height.
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'card-resize-handle';
  resizeHandle.title = currentLang === 'zh' ? '拖动调整卡片大小' : 'Drag to resize card';
  resizeHandle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const startW = card.offsetWidth, startH = card.offsetHeight;
    const onMove = (ev) => {
      node.width = Math.max(200, startW + (ev.clientX - startX) / scale);
      node.height = Math.max(120, startH + (ev.clientY - startY) / scale);
      card.style.width = `${node.width}px`;
      card.style.height = `${node.height}px`;
      card.classList.add('card-resized');
      redrawConnectionsFor(node.id);
      updateCardSizePanel();
      updateMinimap();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveBoard('拖拽调整卡片尺寸');
      updateCardSizePanel();
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  card.appendChild(resizeHandle);

  cardsContainer.appendChild(card);
}

// Resize textarea as user types
// Resize textarea as user types
function autoResizeTextarea(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

// Drag logic for node
function onNodeMouseMove(e) {
  if (!draggedNode) return;
  const dx = e.clientX - nodeDragStartX;
  const dy = e.clientY - nodeDragStartY;
  
  if (viewMode === '3d' && e.ctrlKey) {
    // Translate Z coordinate based on Y mouse movement
    const deltaZ = -dy / scale * 2;
    
    selectedNodeIds.forEach(id => {
      const n = nodes.find(item => item.id === id);
      if (n) {
        n.z = (n.dragStartZ || 0) + deltaZ;
        applyNodeDepthTransform(n);
      }
    });
    drawAllConnections();
  } else {
    // Normal 2D translation in X and Y
    const deltaX = dx / scale;
    const deltaY = dy / scale;
    
    selectedNodeIds.forEach(id => {
      const n = nodes.find(item => item.id === id);
      if (n) {
        n.x = n.dragStartX + deltaX;
        n.y = n.dragStartY + deltaY;
        
        const el = document.getElementById(id);
        if (el) {
          el.style.left = `${n.x}px`;
          el.style.top = `${n.y}px`;
        }
        
        if (viewMode === '3d') {
          drawAllConnections();
        } else {
          redrawConnectionsFor(id);
        }
      }
    });
    updateMinimap();
  }
}

function onNodeMouseUp() {
  document.removeEventListener('mousemove', onNodeMouseMove);
  document.removeEventListener('mouseup', onNodeMouseUp);
  draggedNode = null;
  saveBoard('移动卡片');
}

// Save edited card content
function saveNodeContent(id, text) {
  const node = nodes.find(n => n.id === id);
  if (node) {
    if (!canEditNodeContent(node)) {
      renderBoard();
      return;
    }
    rememberActiveNode(id);
    node.content = text;
    saveBoard('编辑回答');
  }
  renderBoard();
}

function saveNodeQuestion(id, text) {
  const node = nodes.find(n => n.id === id);
  if (node) {
    if (!canEditNodeQuestion(node)) {
      renderBoard();
      return;
    }
    rememberActiveNode(id);
    const oldQuestion = node.question || '';
    const newQuestion = text.trim();
    
    if (newQuestion && newQuestion !== oldQuestion) {
      node.question = text;
      
      // Check if this node has any children
      const hasChildren = nodes.some(n => n.parentId === id);
      if (!hasChildren) {
        // Regenerate AI reply in-place
        node.content = '';
        node.isLoading = true;
        saveBoard('编辑问题并重新回答');
        renderBoard();
        triggerAI(id, id);
        return;
      }
    } else {
      node.question = text;
    }
    saveBoard('编辑问题');
  }
  renderBoard();
}

function manualConnectNoteCards(parentId, childId) {
  const parent = nodes.find(n => n.id === parentId);
  const child = nodes.find(n => n.id === childId);
  if (!parent || !child || parent.id === child.id) return false;

  if (!isManualLinkableNote(parent) || !isManualLinkableNote(child)) {
    alert(currentLang === 'zh'
      ? '\u53ea\u6709\u6ca1\u6709 AI \u56de\u7b54\u7684\u4fbf\u7b7e\u5361\u624d\u80fd\u624b\u52a8\u8fde\u63a5\u3002'
      : 'Only note cards without AI replies can be linked manually.');
    return false;
  }

  if (isNodeAncestor(child.id, parent.id)) {
    alert(currentLang === 'zh'
      ? '\u8fd9\u6837\u8fde\u63a5\u4f1a\u5f62\u6210\u5faa\u73af\u3002'
      : 'That link would create a cycle.');
    return false;
  }

  if (child.parentId && child.parentId !== parent.id) {
    const ok = confirm(currentLang === 'zh'
      ? '\u76ee\u6807\u5361\u7247\u5df2\u7ecf\u6709\u8fde\u63a5\uff0c\u8981\u6539\u8fde\u5230\u5f53\u524d\u8d77\u70b9\u5361\u7247\u5417\uff1f'
      : 'The target card already has a link. Reconnect it to the current source card?');
    if (!ok) return false;
  }

  child.parentId = parent.id;
  rememberActiveNode(child.id);
  selectCardNode(child.id);
  saveBoard(currentLang === 'zh' ? '\u624b\u52a8\u8fde\u63a5\u4fbf\u7b7e' : 'Link note cards');
  renderBoard();
  return true;
}

function manualDisconnectNoteCard(nodeId) {
  const node = nodes.find(n => n.id === nodeId);
  if (!node || !node.parentId || !isManualLinkableNote(node)) return false;

  node.parentId = null;
  rememberActiveNode(node.id);
  selectCardNode(node.id);
  saveBoard(currentLang === 'zh' ? '\u65ad\u5f00\u4fbf\u7b7e\u8fde\u63a5' : 'Unlink note card');
  renderBoard();
  return true;
}

function collectNodeDescendants(ids) {
  const deleteSet = new Set(ids);
  const queue = [...ids];
  while (queue.length > 0) {
    const currentId = queue.pop();
    nodes
      .filter(n => n.parentId === currentId)
      .forEach(child => {
        if (!deleteSet.has(child.id)) {
          deleteSet.add(child.id);
          queue.push(child.id);
        }
      });
  }
  return [...deleteSet];
}

// Delete cards and their descendant branches.
function deleteNodesByIds(ids) {
  const rootIds = [...new Set(ids)].filter(id => nodes.some(n => n.id === id));
  if (rootIds.length === 0) return;

  const deleteList = collectNodeDescendants(rootIds);
  const hasDescendants = deleteList.length > rootIds.length;
  const message = hasDescendants || rootIds.length > 1
    ? `确定删除选中的 ${rootIds.length} 张卡片及其下方分支吗？共会删除 ${deleteList.length} 张卡片。`
    : '确定删除这张卡片吗？';

  if (!confirm(message)) return;

  nodes = nodes.filter(n => !deleteList.includes(n.id));
  selectedNodeIds = selectedNodeIds.filter(id => !deleteList.includes(id));
  saveBoard(deleteList.length > 1 ? `删除 ${deleteList.length} 张卡片` : '删除卡片');
  renderBoard();
}

function deleteSelectedCards() {
  deleteNodesByIds(selectedNodeIds);
}

function deleteNode(id) {
  deleteNodesByIds([id]);
}

// Redraw connection lines for specific node
function redrawConnectionsFor(nodeId) {
  if (flowMode) recomputeBranchColors();
  // Remove existing paths for this node (incoming and outgoing)
  const paths = svgPathsGroup.querySelectorAll(`[data-parent="${nodeId}"], [data-child="${nodeId}"]`);
  paths.forEach(p => p.remove());
  if (connections3dEl) {
    const lines3d = connections3dEl.querySelectorAll(`[data-parent="${nodeId}"], [data-child="${nodeId}"]`);
    lines3d.forEach(line => line.remove());
  }

  // Find incoming
  const node = nodes.find(n => n.id === nodeId);
  if (node && node.parentId) {
    const parent = nodes.find(n => n.id === node.parentId);
    if (parent) drawConnection(parent, node);
  }

  // Find outgoing
  const children = nodes.filter(n => n.parentId === nodeId);
  children.forEach(child => {
    drawConnection(node, child);
  });

  visibleKnowledgeEdges()
    .filter(edge => edge.source === nodeId || edge.target === nodeId)
    .forEach(drawKnowledgeConnection);
}

function get3DConnectionEndpoints(parent, child, cardWidth, parentHeight, childHeight) {
  const parentZ = parent.z || 0;
  const childZ = child.z || 0;
  const parentCenter = {
    x: parent.x + cardWidth / 2,
    y: parent.y + parentHeight / 2,
    z: parentZ
  };
  const childCenter = {
    x: child.x + cardWidth / 2,
    y: child.y + childHeight / 2,
    z: childZ
  };

  const dx = childCenter.x - parentCenter.x;
  const dy = childCenter.y - parentCenter.y;
  const horizontalDominant = Math.abs(dx) >= Math.abs(dy);

  if (horizontalDominant && Math.abs(dx) > 1) {
    return {
      start: {
        x: parentCenter.x + (dx > 0 ? cardWidth / 2 : -cardWidth / 2),
        y: parentCenter.y,
        z: parentZ
      },
      end: {
        x: childCenter.x + (dx > 0 ? -cardWidth / 2 : cardWidth / 2),
        y: childCenter.y,
        z: childZ
      }
    };
  }

  if (Math.abs(dy) > 1) {
    return {
      start: {
        x: parentCenter.x,
        y: parentCenter.y + (dy > 0 ? parentHeight / 2 : -parentHeight / 2),
        z: parentZ
      },
      end: {
        x: childCenter.x,
        y: childCenter.y + (dy > 0 ? -childHeight / 2 : childHeight / 2),
        z: childZ
      }
    };
  }

  return {
    start: parentCenter,
    end: childCenter
  };
}

function draw3DConnection(parent, child, parentEl, childEl, cardWidth, parentHeight, childHeight) {
  if (!connections3dEl || !parentEl || !childEl) return;

  const { start, end } = get3DConnectionEndpoints(parent, child, cardWidth, parentHeight, childHeight);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1) return;

  const angleXY = Math.atan2(dy, dx);
  const angleZ = Math.atan2(dz, Math.hypot(dx, dy));
  const line = document.createElement('div');
  line.className = 'connection-3d-line';
  line.dataset.parent = parent.id;
  line.dataset.child = child.id;
  line.style.left = `${start.x}px`;
  line.style.top = `${start.y - 1.5}px`;
  line.style.width = `${distance}px`;
  line.style.transform = `translateZ(${start.z}px) rotateZ(${angleXY}rad) rotateY(${-angleZ}rad)`;
  if (flowMode) {
    const c = getBranchColor(child.id);
    line.style.backgroundImage = `linear-gradient(90deg, ${c}33, ${c})`;
  }

  const highlight = () => line.classList.add('active');
  const unhighlight = () => line.classList.remove('active');
  parentEl.addEventListener('mouseenter', highlight);
  parentEl.addEventListener('mouseleave', unhighlight);
  childEl.addEventListener('mouseenter', highlight);
  childEl.addEventListener('mouseleave', unhighlight);

  connections3dEl.appendChild(line);
}

// Draw a SVG path between parent and child nodes
function drawConnection(parent, child) {
  const parentEl = document.getElementById(parent.id);
  const childEl = document.getElementById(child.id);
  
  const parentHeight = parentEl ? parentEl.offsetHeight : 150;
  const childHeight = childEl ? childEl.offsetHeight : 150;
  // Use each card's actual width so connections stay attached to resized cards.
  const parentWidth = parentEl ? parentEl.offsetWidth : getCardWidth();
  const childWidth = childEl ? childEl.offsetWidth : getCardWidth();

  let x1, y1, x2, y2, cpX, cpY, pathData;

  // Smart connection logic based on relative positions
  const isHorizontalFlow = child.x > parent.x + parentWidth - 20;

  if (viewMode === '3d') {
    draw3DConnection(parent, child, parentEl, childEl, parentWidth, parentHeight, childHeight);
    return;
  } else {
    if (isHorizontalFlow) {
      // Right port of parent to Left port of child
      x1 = parent.x + parentWidth;
      y1 = parent.y + parentHeight / 2;
      x2 = child.x;
      y2 = child.y + childHeight / 2;
      cpX = (x2 - x1) * 0.5;
      pathData = `M ${x1} ${y1} C ${x1 + cpX} ${y1}, ${x2 - cpX} ${y2}, ${x2} ${y2}`;
    } else {
      // Bottom port of parent to Top port of child
      x1 = parent.x + parentWidth / 2;
      y1 = parent.y + parentHeight;
      x2 = child.x + childWidth / 2;
      y2 = child.y;
      cpY = (y2 - y1) * 0.5;
      pathData = `M ${x1} ${y1} C ${x1} ${y1 + cpY}, ${x2} ${y2 - cpY}, ${x2} ${y2}`;
    }
  }

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  path.setAttribute('class', 'connection-path');
  path.setAttribute('data-parent', parent.id);
  path.setAttribute('data-child', child.id);
  if (flowMode) {
    path.style.setProperty('--branch-color', getBranchColor(child.id));
  }

  // Highlight connection on card hover (optional style detail)
  if (parentEl && childEl) {
    const highlight = () => path.classList.add('active');
    const unhighlight = () => path.classList.remove('active');
    parentEl.addEventListener('mouseenter', highlight);
    parentEl.addEventListener('mouseleave', unhighlight);
    childEl.addEventListener('mouseenter', highlight);
    childEl.addEventListener('mouseleave', unhighlight);
  }

  svgPathsGroup.appendChild(path);
}

function drawKnowledgeConnection(edge) {
  if (viewMode === '3d' || !edge) return;
  const source = nodes.find(node => node.id === edge.source);
  const target = nodes.find(node => node.id === edge.target);
  if (!source || !target) return;
  const sourceEl = document.getElementById(source.id);
  const targetEl = document.getElementById(target.id);
  if (!sourceEl || !targetEl) return;

  const sourceWidth = sourceEl.offsetWidth || getCardWidth();
  const targetWidth = targetEl.offsetWidth || getCardWidth();
  const sourceHeight = sourceEl.offsetHeight || 180;
  const targetHeight = targetEl.offsetHeight || 180;
  const horizontal = target.x > source.x + sourceWidth - 20;
  let x1, y1, x2, y2, pathData;
  if (horizontal) {
    x1 = source.x + sourceWidth;
    y1 = source.y + sourceHeight / 2;
    x2 = target.x;
    y2 = target.y + targetHeight / 2;
    const cpX = (x2 - x1) * 0.5;
    pathData = `M ${x1} ${y1} C ${x1 + cpX} ${y1}, ${x2 - cpX} ${y2}, ${x2} ${y2}`;
  } else {
    x1 = source.x + sourceWidth / 2;
    y1 = source.y + sourceHeight;
    x2 = target.x + targetWidth / 2;
    y2 = target.y;
    const cpY = (y2 - y1) * 0.5;
    pathData = `M ${x1} ${y1} C ${x1} ${y1 + cpY}, ${x2} ${y2 - cpY}, ${x2} ${y2}`;
  }

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  path.setAttribute('class', 'connection-path knowledge-connection-path');
  path.setAttribute('data-parent', source.id);
  path.setAttribute('data-child', target.id);
  path.setAttribute('data-knowledge-edge', '1');
  const relation = String(edge.relation || '补充');
  path.setAttribute('data-relation', relation);
  path.style.setProperty('--knowledge-edge-color', knowledgeRelationColor(relation));
  const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  title.textContent = `${relation}${edge.reason ? `：${edge.reason}` : ''}`;
  path.appendChild(title);
  svgPathsGroup.appendChild(path);
}

function knowledgeRelationColor(relation) {
  return ({
    '延伸': '#60a5fa',
    '相似': '#a78bfa',
    '对比': '#f59e0b',
    '依赖': '#f87171',
    '补充': '#34d399'
  })[relation] || '#94a3b8';
}

// User clicked "+ Follow-up"
function promptFollowUp(parentId) {
  const parent = nodes.find(n => n.id === parentId);
  if (!parent) return false;

  const promptText = prompt(translations[currentLang].followUpPrompt);
  if (!promptText || promptText.trim() === '') return false;

  const cardWidth = getCardWidth();
  const isLong = promptText.trim().length > 500;
  
  // New cards stay on the same plane as their parent. Depth is opt-in:
  // hold Ctrl and drag a card in 3D view to push it along the Z axis.
  const nextZ = parent.z || 0;

  if (isLong) {
    // 1. Create user card connected to parent
    const userNodeId = `node_${Date.now()}_u`;
    const userNode = {
      id: userNodeId,
      parentId: parentId,
      role: 'user',
      content: promptText.trim(),
      x: parent.x + cardWidth + 120,
      y: parent.y,
      z: nextZ,
      isFollowUp: true, // explicit branch, not an imported continuation
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    nodes.push(userNode);

    // 2. Create AI placeholder node connected to user card
    const aiNodeId = `node_${Date.now()}_ai`;
    const aiNode = {
      id: aiNodeId,
      parentId: userNodeId,
      role: 'assistant',
      content: '',
      x: userNode.x + cardWidth + 120,
      y: userNode.y,
      z: nextZ,
      isLoading: true,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    nodes.push(aiNode);
    
    saveBoard('新增追问');
    renderBoard();
    rememberActiveNode(aiNode.id);
    selectCardNode(aiNode.id);
    if (cardLayout === 'wide') arrangeVertical();
    focusOnNode(aiNode.id);
    triggerAI(userNodeId, aiNodeId);
    return true;
  } else {
    // Create unified dialogue card connected directly to parent
    const aiNodeId = `node_${Date.now()}_ai`;
    const aiNode = {
      id: aiNodeId,
      parentId: parentId,
      role: 'dialogue',
      question: promptText.trim(),
      content: '',
      x: parent.x + cardWidth + 120,
      y: parent.y,
      z: nextZ,
      isLoading: true,
      isFollowUp: true, // explicit branch, not an imported continuation
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    nodes.push(aiNode);
    
    saveBoard('新增追问');
    renderBoard();
    if (cardLayout === 'wide') arrangeVertical();
    focusOnNode(aiNode.id);
    triggerAI(aiNodeId, aiNodeId);
    return true;
  }
}

// Follow up on a message from the chat view. Leave the chat view first so the
// canvas is visible (and laid out) when promptFollowUp focuses the new card.
function followUpFromChat(parentId) {
  setChatMode(false);
  promptFollowUp(parentId);
}

// Jump from a chat message back to its card on the canvas (centered to read).
function locateOnCanvas(nodeId) {
  setChatMode(false);
  centerOnNode(nodeId);
}

// AI trigger
async function triggerAI(userNodeId, aiNodeId) {
  const aiNode = nodes.find(n => n.id === aiNodeId);
  if (!aiNode) return;

  // Trace history path
  const history = traceConversationHistory(userNodeId);

  try {
    let responseText = '';
    if (config.provider === 'mock') {
      responseText = await generateMockAI(history);
    } else {
      responseText = await generateRealAPI(history);
    }
    
    // Typing simulation effect
    simulateTyping(aiNodeId, responseText);

  } catch (error) {
    console.error(error);
    aiNode.content = `❌ 出错啦: ${error.message || '网络或接口故障。请检查您的 API Key 或服务商配置。'}`;
    aiNode.isLoading = false;
    saveBoard('AI 回答出错');
    renderBoard();
  }
}

// Convert user node to dialogue and trigger AI response in place
function triggerAIForUserNode(nodeId) {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return;

  const isPlaceholder = node.content === translations['zh'].doubleClickEdit || 
                        node.content === translations['en'].doubleClickEdit ||
                        !node.content || 
                        node.content.trim() === '';

  if (isPlaceholder && !node.image) {
    alert(currentLang === 'zh' ? '请先双击卡片输入您的问题。' : 'Please double-click the card to enter your question first.');
    return;
  }

  // Convert the user node to a dialogue node
  node.role = 'dialogue';
  node.question = isPlaceholder ? '' : node.content;
  node.content = '';
  node.isLoading = true;

  saveBoard('让 AI 回答');
  renderBoard();
  focusOnNode(nodeId);
  triggerAI(nodeId, nodeId);
}

// Clear response and trigger AI regeneration for dialogue cards in place
function regenerateDialogueNode(nodeId) {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return;

  node.content = '';
  node.isLoading = true;

  saveBoard('重新回答');
  renderBoard();
  focusOnNode(nodeId);
  triggerAI(nodeId, nodeId);
}

// Trigger file upload from user card or leaf dialogue card
function triggerCardFileUpload(nodeId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,.txt,.md,.csv,.log';
  
  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    
    const reader = new FileReader();
    
    if (file.type.startsWith('image/')) {
      reader.onload = function(event) {
        node.image = event.target.result;
        node.imageName = file.name;
        saveBoard('添加附件');
        renderBoard();
      };
      reader.readAsDataURL(file);
    } else {
      reader.onload = function(event) {
        const text = event.target.result;
        let formattedText = '';
        
        if (file.name.endsWith('.csv')) {
          formattedText = csvToMarkdown(text);
        } else {
          formattedText = `\n\n--- [Attached File: ${file.name}] ---\n\`\`\`${file.name.split('.').pop()}\n${text}\n\`\`\``;
        }
        
        const placeholderZh = translations['zh'].doubleClickEdit;
        const placeholderEn = translations['en'].doubleClickEdit;
        
        // Append text to node.question for dialogue cards, or node.content for normal cards
        if (node.role === 'dialogue') {
          if (!node.question || node.question === placeholderZh || node.question === placeholderEn) {
            node.question = formattedText.trim();
          } else {
            node.question += formattedText;
          }
        } else {
          if (node.content === placeholderZh || node.content === placeholderEn || !node.content) {
            node.content = formattedText.trim();
          } else {
            node.content += formattedText;
          }
        }
        
        saveBoard('添加附件');
        renderBoard();
      };
      reader.readAsText(file);
    }
  });
  
  input.click();
}

// Simple CSV to Markdown table parser
function csvToMarkdown(csvText) {
  const lines = csvText.split(/\r?\n/).map(line => line.trim()).filter(line => line);
  if (lines.length === 0) return '';
  
  const rows = lines.map(line => {
    return line.split(',').map(cell => cell.replace(/^["']|["']$/g, '').trim());
  });
  
  const colCount = Math.max(...rows.map(r => r.length));
  
  const mdRows = rows.map(row => {
    while (row.length < colCount) row.push('');
    return '| ' + row.join(' | ') + ' |';
  });
  
  const divider = '| ' + Array(colCount).fill('---').join(' | ') + ' |';
  mdRows.splice(1, 0, divider);
  
  return '\n\n' + mdRows.join('\n');
}

// Trace back from the current node to the root, forming an array of messages
function traceConversationHistory(nodeId) {
  const history = [];
  let currentId = nodeId;
  
  while (currentId) {
    const node = nodes.find(n => n.id === currentId);
    if (!node) break;
    
    if (node.question !== undefined) {
      if (node.id !== nodeId && node.content) {
        history.unshift({
          role: 'model',
          content: node.content
        });
      }
      history.unshift({
        role: 'user',
        content: node.question,
        image: node.image
      });
    } else {
      history.unshift({
        role: node.role === 'user' ? 'user' : 'model',
        content: node.content,
        image: node.image
      });
    }
    
    currentId = node.parentId;
  }
  return history;
}

// Typing simulator for premium microinteraction
function simulateTyping(nodeId, text) {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return;

  node.isLoading = false;
  node.content = '';
  
  let i = 0;
  const speed = 15; // ms per char
  const timer = setInterval(() => {
    if (i < text.length) {
      node.content += text.charAt(i);
      // Update element content directly to prevent full re-render flickering
      const cardEl = document.getElementById(nodeId);
      if (cardEl) {
        const displayEl = cardEl.querySelector('.card-text-display');
        if (displayEl) {
          displayEl.classList.remove('hidden');
          displayEl.innerHTML = renderMarkdown(node.content);
        }
        const loaderEl = cardEl.querySelector('.ai-typing-indicator');
        if (loaderEl) loaderEl.remove();
        
        // Redraw lines since height changes dynamically as content flows in
        redrawConnectionsFor(nodeId);
      }
      i++;
    } else {
      clearInterval(timer);
      saveBoard('AI 回答');
      renderBoard(); // Final clean redraw
      refreshConvoPreviewForNode(nodeId);
    }
  }, speed);
}

// Generate Mock AI responses based on inputs
function generateMockAI(history) {
  return new Promise((resolve) => {
    setTimeout(() => {
      const lastPrompt = history[history.length - 1].content;
      
      const containsHello = lastPrompt.includes('你好') || lastPrompt.toLowerCase().includes('hello') || lastPrompt.toLowerCase().includes('hi');
      const containsGravity = lastPrompt.includes('引力波') || lastPrompt.toLowerCase().includes('gravity') || lastPrompt.toLowerCase().includes('gravitational');

      if (containsHello) {
        resolve(translations[currentLang].mockAiResponse1);
      } else if (containsGravity) {
        resolve(translations[currentLang].mockAiResponse2);
      } else {
        resolve(translations[currentLang].mockAiDefaultResponse.replace('{prompt}', lastPrompt));
      }
    }, 1000);
  });
}

// Call Gemini or Custom API
async function generateRealAPI(history) {
  const apiKey = config.apiKey;
  // If provider is gemini, API key is required. For custom providers (like Ollama), it's optional.
  if (config.provider === 'gemini' && !apiKey) {
    throw new Error(translations[currentLang].errorApiKey);
  }

  const model = config.model || 'gemini-1.5-flash';
  const endpoint = config.endpoint || 'https://generativelanguage.googleapis.com';
  
  if (config.provider === 'custom') {
    // OpenAI-compatible / Ollama call
    let url = endpoint.trim();
    if (!url.includes('/v1/') && !url.includes('/api/')) {
      url = url.replace(/\/+$/, '') + '/v1/chat/completions';
    }
    
    const messages = history.map(h => {
      const role = h.role === 'model' || h.role === 'assistant' ? 'assistant' : 'user';
      let content = h.content || '';
      if (h.image) {
        content = [
          { type: 'text', text: h.content || '' },
          { type: 'image_url', image_url: { url: h.image } }
        ];
      }
      return { role, content };
    });

    const headers = {
      'Content-Type': 'application/json'
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: model,
        messages: messages
      })
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      let errorMessage = `API 请求失败: HTTP ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorMessage;
      } catch (e) {
        if (errorText) errorMessage += ` - ${errorText.substring(0, 100)}`;
      }
      throw new Error(errorMessage);
    }

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content;
    if (!answer) {
      throw new Error('API 返回的数据中未包含回复内容。');
    }
    return answer;
  } else {
    // Format history for Gemini API
    const contents = history.map(h => {
      const role = h.role === 'model' || h.role === 'assistant' ? 'model' : 'user';
      const parts = [{ text: h.content || '' }];
      if (h.image) {
        const match = h.image.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/);
        if (match) {
          parts.push({
            inlineData: {
              mimeType: match[1],
              data: match[2]
            }
          });
        }
      }
      return { role, parts };
    });

    const url = `${endpoint}/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ contents })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `API 请求失败: HTTP ${response.status}`);
    }

    const data = await response.json();
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!answer) {
      throw new Error('API 返回的数据中未包含回复内容。');
    }

    return answer;
  }
}

// Import parsing lives in scripts/importer.js. This override keeps app.js focused
// on turning normalized import items into positioned cards.
function handleChatLogImport(rawText, format, arrangeHorizontally) {
  let parsedMessages = [];
  try {
    parsedMessages = importerModule.parseChatLog(rawText, format);
  } catch (e) {
    alert(currentLang === 'zh' ? `解析 JSON 失败: ${e.message}` : `Failed to parse JSON: ${e.message}`);
    return;
  }

  if (parsedMessages.length === 0) {
    alert(currentLang === 'zh'
      ? '未能识别出任何对话记录，请检查格式。'
      : 'No conversation messages were recognized. Please check the format.');
    return;
  }

  const startX = 25000 - 150;
  const startY = 25000 - 200;
  const cardWidth = getCardWidth();
  let lastNodeId = null;

  if (nodes.length <= 2 && nodes.some(n => n.id.includes('welcome'))) {
    nodes = [];
  }

  const processedNodesList = importerModule.createImportCardItems(parsedMessages);
  const nodesAddedCount = processedNodesList.length;

  processedNodesList.forEach((item, index) => {
    const id = `imported_${Date.now()}_${index}`;
    let x;
    let y;
    const z = 0;

    if (arrangeHorizontally) {
      x = startX + index * (cardWidth + 120);
      y = startY + (item.role === 'user' ? -50 : (item.role === 'assistant' ? 50 : 0));
    } else {
      x = startX;
      y = startY + index * 260;
    }

    const nodeData = {
      id,
      parentId: lastNodeId,
      role: item.role,
      content: item.content,
      x,
      y,
      z,
      timestamp: item.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    if (item.question !== undefined) {
      nodeData.question = item.question;
    }

    nodes.push(nodeData);
    lastNodeId = id;
  });

  saveBoard('导入聊天记录');
  renderBoard();
  if (cardLayout === 'wide') arrangeVertical();

  document.getElementById('import-modal').classList.add('hidden');

  if (nodes.length > 0) {
    centerOnNode(nodes[nodes.length - nodesAddedCount].id);
  }
}

function isKnowledgeCardItem(item) {
  return !!item && typeof item === 'object'
    && (item.title || item.summary_q || item.summary_a || item.category)
    && !('x' in item && 'y' in item);
}

function isKnowledgeImportData(data) {
  if (Array.isArray(data)) return data.some(isKnowledgeCardItem);
  if (!data || typeof data !== 'object') return false;
  if (Array.isArray(data.cards)) return data.cards.some(isKnowledgeCardItem);
  return Array.isArray(data.nodes)
    && data.nodes.some(isKnowledgeCardItem)
    && !data.nodes.some(item => item && 'x' in item && 'y' in item);
}

function importKnowledgeData(data, sourceName = 'knowledge-canvas.json') {
  const cards = Array.isArray(data) ? data
    : (Array.isArray(data?.cards) ? data.cards : (Array.isArray(data?.nodes) ? data.nodes : []));
  if (!cards.length) throw new Error('知识文件中没有可导入的卡片');

  const incomingIds = new Set(nodes.map(node => node.id));
  const startX = 25000 - 150;
  const startY = 25000 - 200;
  const cardWidth = getCardWidth();
  const importedIdMap = new Map();
  const importedNodes = cards.filter(isKnowledgeCardItem).map((card, index) => {
    const originalId = String(card.id || `qa-${index + 1}`);
    let id = originalId;
    let suffix = 2;
    while (incomingIds.has(id)) id = `${originalId}-${suffix++}`;
    incomingIds.add(id);
    importedIdMap.set(originalId, id);

    const title = String(card.title || card.heading || `知识卡片 ${index + 1}`).trim();
    const question = String(card.summary_q || card.question || title).trim();
    const answer = String(card.summary_a || card.content || '').trim();
    const keywords = Array.isArray(card.keywords) ? card.keywords.map(String) : [];
    const content = String(card.content || `# ${title}\n\n**分类**：${card.category || '其他'}\n\n**问**：${question}\n\n**答**：${answer}\n\n**关键词**：${keywords.join('、')}`).trim();
    return {
      id,
      parentId: null,
      role: 'user',
      content,
      x: startX + (index % 4) * (cardWidth + 120),
      y: startY + Math.floor(index / 4) * 280,
      z: 0,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      knowledge: {
        id: originalId,
        title,
        category: String(card.category || '其他'),
        summary_q: question,
        summary_a: answer,
        keywords,
        source: String(card.source || sourceName),
        heading: String(card.heading || '')
      }
    };
  });

  if (!importedNodes.length) throw new Error('没有识别出有效知识卡片');
  const rawEdges = Array.isArray(data?.edges) ? data.edges
    : (Array.isArray(data?.links) ? data.links : []);
  const importedEdges = rawEdges.map(edge => ({
    source: importedIdMap.get(String(edge.source || edge.fromNode || '')),
    target: importedIdMap.get(String(edge.target || edge.toNode || '')),
    relation: String(edge.relation || edge.label || '补充'),
    reason: String(edge.reason || '')
  })).filter(edge => edge.source && edge.target && edge.source !== edge.target);

  nodes = nodes.concat(importedNodes);
  knowledgeEdges = knowledgeEdges.concat(importedEdges);
  saveKnowledgeEdges();
  saveBoard('导入知识卡片');
  renderBoard();
  centerOnNode(importedNodes[0].id);
  return importedNodes.length;
}

async function analyzeFileWithBridge(file) {
  const bridgeUrl = 'http://127.0.0.1:8787';
  const raw = await file.arrayBuffer();
  const contentBase64 = btoa(String.fromCharCode(...new Uint8Array(raw)));
  const response = await fetch(`${bridgeUrl}/api/knowledge/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      content_base64: contentBase64,
      provider: 'local',
      endpoint: 'http://127.0.0.1:11434',
      model: 'qwen2.5:3b',
      dry_run: true
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `桥接服务 HTTP ${response.status}`);
  if (!result.graph) throw new Error('桥接服务未返回知识图谱');
  importKnowledgeData(result.graph, file.name);
}

async function linkCurrentKnowledgeCards() {
  if (nodes.length < 2) {
    alert(currentLang === 'zh' ? '至少需要两张卡片才能建立知识关联。' : 'At least two cards are required.');
    return;
  }
  if (config.provider === 'gemini') {
    alert(currentLang === 'zh'
      ? '知识关联目前需要 Custom LLM（OpenAI 兼容接口）或模拟模式。'
      : 'Knowledge linking requires Custom LLM (OpenAI-compatible) or mock mode.');
    return;
  }
  const button = document.getElementById('link-knowledge-btn');
  if (button) { button.disabled = true; button.textContent = currentLang === 'zh' ? '关联中…' : 'Linking…'; }
  try {
    const endpoint = config.endpoint || 'http://127.0.0.1:11434';
    const provider = config.provider === 'mock'
      ? 'local'
      : (/localhost:11434|127\.0\.0\.1:11434/i.test(endpoint) ? 'local' : 'cloud');
    const cards = nodes.map((node, index) => {
      const knowledge = node.knowledge || {};
      const title = knowledge.title || node.question || `对话 ${index + 1}`;
      return {
        id: node.id,
        title,
        category: knowledge.category || '其他',
        summary_q: knowledge.summary_q || node.question || node.content || title,
        summary_a: knowledge.summary_a || (node.question !== undefined ? node.content : node.content || ''),
        keywords: knowledge.keywords || [],
        source: knowledge.source || 'qibu'
      };
    });
    const response = await fetch('http://127.0.0.1:8787/api/knowledge/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cards,
        provider,
        endpoint,
        model: config.model || (provider === 'local' ? 'qwen2.5:3b' : 'gpt-5.6-terra'),
        api_key: config.apiKey || '',
        dry_run: config.provider === 'mock'
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `桥接服务 HTTP ${response.status}`);
    knowledgeEdges = Array.isArray(result.graph?.edges) ? result.graph.edges : [];
    saveKnowledgeEdges();
    renderBoard();
    alert(currentLang === 'zh'
      ? `关联完成：${knowledgeEdges.length} 条关系边。`
      : `Linking complete: ${knowledgeEdges.length} relation edges.`);
  } catch (error) {
    console.error(error);
    alert(currentLang === 'zh'
      ? `关联失败：${error.message}。请确认 bridge/server.py 已启动。`
      : `Linking failed: ${error.message}. Start bridge/server.py first.`);
  } finally {
    if (button) { button.disabled = false; applyTranslations(); }
  }
}

const securityModule = window.MindChatModules.createSecurityModule();

function renderMarkdown(text) {
  return securityModule.renderMarkdown(text);
}

// Center viewport on node
function focusOnNode(nodeId) {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return;

  if (viewMode === '3d') {
    const relatedNodes = [node];
    if (node.parentId) {
      const parent = nodes.find(n => n.id === node.parentId);
      if (parent) relatedNodes.unshift(parent);
    }
    const children = nodes.filter(n => n.parentId === node.id);
    relatedNodes.push(...children);
    fitNodesInViewport(relatedNodes, { maxScale: 0.9, padding: 96 });
    return;
  }

  // Target translation so the node is centered
  transformX = -node.x * scale + (canvasViewport.offsetWidth - 320) / 2; // offset sidebar
  transformY = -node.y * scale + canvasViewport.offsetHeight / 2;
  
  updateTransform();
}

function fitNodesInViewport(targetNodes = nodes, options = {}) {
  const visibleNodes = targetNodes.filter(Boolean);
  if (visibleNodes.length === 0) return;

  const padding = options.padding ?? 120;
  const minScale = options.minScale ?? 0.35;
  const maxScale = options.maxScale ?? 0.95;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;

  visibleNodes.forEach(node => {
    const el = document.getElementById(node.id);
    const cardWidth = node.width || (el ? el.offsetWidth : getCardWidth());
    const cardHeight = el ? el.offsetHeight : 240;
    left = Math.min(left, node.x);
    right = Math.max(right, node.x + cardWidth);
    top = Math.min(top, node.y);
    bottom = Math.max(bottom, node.y + cardHeight);
  });

  const vpWidth = canvasViewport.offsetWidth || window.innerWidth;
  const vpHeight = canvasViewport.offsetHeight || window.innerHeight;
  const contentWidth = Math.max(1, right - left);
  const contentHeight = Math.max(1, bottom - top);
  const availableWidth = Math.max(180, vpWidth - padding * 2);
  const availableHeight = Math.max(180, vpHeight - padding * 2);
  const fitScale = Math.min(availableWidth / contentWidth, availableHeight / contentHeight);

  scale = Math.max(minScale, Math.min(maxScale, fitScale));
  transformX = vpWidth / 2 - ((left + right) / 2) * scale;
  transformY = vpHeight / 2 - ((top + bottom) / 2) * scale;

  updateTransform();
  updateZoomIndicator();
}

// Center a single card in the viewport at a readable zoom. Used when jumping
// back from the chat / tree views so the card can actually be read.
function centerOnNode(nodeId) {
  const node = nodes.find(n => n.id === nodeId);
  if (!node) return;
  fitNodesInViewport([node], { maxScale: 1.1, minScale: 0.6, padding: 200 });
}

function focusSelectedCard() {
  const node = getActiveSizeNode();
  if (!node) return;
  if (chatMode) setChatMode(false);
  if (treeMode) setTreeMode(false);
  fitNodesInViewport([node], { maxScale: 1.25, minScale: 0.8, padding: 220 });

  requestAnimationFrame(() => {
    const el = document.getElementById(node.id);
    if (el) {
      el.classList.add('search-flash');
      setTimeout(() => el.classList.remove('search-flash'), 1200);
    }
  });
}

// ---- Global search: find a card by content and jump to it (centered) ----
function jumpToCard(nodeId) {
  if (chatMode) setChatMode(false);
  if (treeMode) setTreeMode(false);
  centerOnNode(nodeId);
  // Brief highlight pulse so the target card is easy to spot.
  requestAnimationFrame(() => {
    const el = document.getElementById(nodeId);
    if (el) {
      el.classList.add('search-flash');
      setTimeout(() => el.classList.remove('search-flash'), 1500);
    }
  });
}

function getViewportWorldRect() {
  const vpWidth = canvasViewport.offsetWidth || window.innerWidth;
  const vpHeight = canvasViewport.offsetHeight || window.innerHeight;
  return {
    left: -transformX / scale,
    top: -transformY / scale,
    right: (vpWidth - transformX) / scale,
    bottom: (vpHeight - transformY) / scale
  };
}

function getMinimapBounds() {
  const viewport = getViewportWorldRect();
  let left = viewport.left;
  let top = viewport.top;
  let right = viewport.right;
  let bottom = viewport.bottom;

  nodes.forEach(node => {
    const width = getNodeRenderedWidth(node);
    const height = getNodeRenderedHeight(node);
    left = Math.min(left, node.x);
    top = Math.min(top, node.y);
    right = Math.max(right, node.x + width);
    bottom = Math.max(bottom, node.y + height);
  });
  annotations.forEach(annotation => {
    left = Math.min(left, annotation.x);
    top = Math.min(top, annotation.y);
    right = Math.max(right, annotation.x);
    bottom = Math.max(bottom, annotation.y);
  });

  if (!Number.isFinite(left + top + right + bottom)) return null;
  if (right - left < 1) right = left + 1;
  if (bottom - top < 1) bottom = top + 1;

  const pad = Math.max(160, Math.max(right - left, bottom - top) * 0.08);
  return {
    left: left - pad,
    top: top - pad,
    right: right + pad,
    bottom: bottom + pad
  };
}

function getMinimapProjection(bounds) {
  if (!minimapEl || !bounds) return null;
  const width = minimapEl.clientWidth;
  const height = minimapEl.clientHeight;
  if (width <= 0 || height <= 0) return null;

  const worldWidth = bounds.right - bounds.left;
  const worldHeight = bounds.bottom - bounds.top;
  const fit = Math.min(width / worldWidth, height / worldHeight);
  const offsetX = (width - worldWidth * fit) / 2;
  const offsetY = (height - worldHeight * fit) / 2;

  return {
    width,
    height,
    fit,
    offsetX,
    offsetY,
    toMiniX: (x) => offsetX + (x - bounds.left) * fit,
    toMiniY: (y) => offsetY + (y - bounds.top) * fit,
    toWorldX: (x) => bounds.left + (x - offsetX) / fit,
    toWorldY: (y) => bounds.top + (y - offsetY) / fit
  };
}

function updateMinimap() {
  if (!minimapEl || !minimapStage) return;

  const bounds = getMinimapBounds();
  const projection = getMinimapProjection(bounds);
  if (!bounds || !projection) return;

  minimapStage.innerHTML = '';

  if (nodes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'minimap-empty';
    empty.textContent = currentLang === 'zh' ? '暂无卡片' : 'No cards';
    minimapStage.appendChild(empty);
  }

  nodes.forEach(node => {
    if (!node.parentId) return;
    const parent = nodes.find(n => n.id === node.parentId);
    if (!parent) return;

    const parentWidth = getNodeRenderedWidth(parent);
    const parentHeight = getNodeRenderedHeight(parent);
    const nodeWidth = getNodeRenderedWidth(node);
    const nodeHeight = getNodeRenderedHeight(node);
    const x1 = projection.toMiniX(parent.x + parentWidth / 2);
    const y1 = projection.toMiniY(parent.y + parentHeight / 2);
    const x2 = projection.toMiniX(node.x + nodeWidth / 2);
    const y2 = projection.toMiniY(node.y + nodeHeight / 2);
    const length = Math.hypot(x2 - x1, y2 - y1);
    const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;

    const link = document.createElement('div');
    link.className = 'minimap-link';
    link.style.left = `${x1}px`;
    link.style.top = `${y1}px`;
    link.style.width = `${Math.max(2, length)}px`;
    link.style.transform = `rotate(${angle}deg)`;
    minimapStage.appendChild(link);
  });

  nodes.forEach(node => {
    const isDialogue = node.question !== undefined || node.role === 'dialogue';
    const role = isDialogue ? 'dialogue' : node.role;
    const x = projection.toMiniX(node.x);
    const y = projection.toMiniY(node.y);
    const width = Math.max(5, getNodeRenderedWidth(node) * projection.fit);
    const height = Math.max(4, getNodeRenderedHeight(node) * projection.fit);

    const item = document.createElement('div');
    item.className = `minimap-node role-${role}`;
    item.style.left = `${x}px`;
    item.style.top = `${y}px`;
    item.style.width = `${width}px`;
    item.style.height = `${height}px`;
    minimapStage.appendChild(item);
  });

  annotations.forEach(annotation => {
    const item = document.createElement('div');
    item.className = 'minimap-annotation';
    item.style.left = `${projection.toMiniX(annotation.x)}px`;
    item.style.top = `${projection.toMiniY(annotation.y)}px`;
    minimapStage.appendChild(item);
  });

  const viewport = getViewportWorldRect();
  const viewportEl = document.createElement('div');
  viewportEl.className = 'minimap-viewport';
  viewportEl.style.left = `${projection.toMiniX(viewport.left)}px`;
  viewportEl.style.top = `${projection.toMiniY(viewport.top)}px`;
  viewportEl.style.width = `${Math.max(10, (viewport.right - viewport.left) * projection.fit)}px`;
  viewportEl.style.height = `${Math.max(8, (viewport.bottom - viewport.top) * projection.fit)}px`;
  minimapStage.appendChild(viewportEl);
}

function centerViewportOnWorldPoint(x, y) {
  const vpWidth = canvasViewport.offsetWidth || window.innerWidth;
  const vpHeight = canvasViewport.offsetHeight || window.innerHeight;
  transformX = vpWidth / 2 - x * scale;
  transformY = vpHeight / 2 - y * scale;
  updateTransform();
}

function moveViewportFromMinimapEvent(e) {
  if (!minimapEl) return;
  const bounds = getMinimapBounds();
  const projection = getMinimapProjection(bounds);
  if (!projection) return;

  const rect = minimapEl.getBoundingClientRect();
  const miniX = Math.max(0, Math.min(projection.width, e.clientX - rect.left));
  const miniY = Math.max(0, Math.min(projection.height, e.clientY - rect.top));
  centerViewportOnWorldPoint(projection.toWorldX(miniX), projection.toWorldY(miniY));
}

function setupMinimapNavigation() {
  if (!minimapEl) return;
  let dragging = false;

  minimapEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    minimapEl.setPointerCapture?.(e.pointerId);
    moveViewportFromMinimapEvent(e);
  });

  minimapEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    moveViewportFromMinimapEvent(e);
  });

  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    minimapEl.releasePointerCapture?.(e.pointerId);
  };
  minimapEl.addEventListener('pointerup', stop);
  minimapEl.addEventListener('pointercancel', stop);
}

function highlightMatch(text, query) {
  const max = 72;
  const lower = text.toLowerCase();
  const ql = query.toLowerCase();
  const idx = lower.indexOf(ql);
  let snippet = text;
  if (idx > 25) snippet = '…' + text.slice(idx - 20);
  if (snippet.length > max) snippet = snippet.slice(0, max) + '…';
  const esc = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  if (!query) return esc(snippet);
  const si = snippet.toLowerCase().indexOf(ql);
  if (si === -1) return esc(snippet);
  return esc(snippet.slice(0, si)) + '<mark>' + esc(snippet.slice(si, si + query.length)) +
    '</mark>' + esc(snippet.slice(si + query.length));
}

function setupGlobalSearch() {
  const input = document.getElementById('global-search-input');
  const resultsEl = document.getElementById('search-results');
  if (!input || !resultsEl) return;

  const hide = () => { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; };

  const run = () => {
    const query = input.value.trim();
    if (!query) { hide(); return; }
    const q = query.toLowerCase();
    const matches = nodes.filter(n =>
      `${n.question || ''} ${n.content || ''}`.toLowerCase().includes(q)
    ).slice(0, 30);

    resultsEl.innerHTML = '';
    if (matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'search-empty';
      empty.textContent = translations[currentLang].searchNoResult;
      resultsEl.appendChild(empty);
      resultsEl.classList.remove('hidden');
      return;
    }

    matches.forEach(n => {
      const isDialogue = n.question !== undefined || n.role === 'dialogue';
      const icon = isDialogue ? '💬' : (n.role === 'user' ? '👤' : '🤖');
      const raw = `${n.question ? n.question + ' / ' : ''}${n.content || ''}`
        .replace(/\s+/g, ' ').trim();

      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML = `<span class="search-result-icon">${icon}</span>` +
        `<span class="search-result-text">${highlightMatch(raw, query)}</span>`;
      item.addEventListener('click', () => { jumpToCard(n.id); hide(); });
      resultsEl.appendChild(item);
    });
    resultsEl.classList.remove('hidden');
  };

  input.addEventListener('input', run);
  input.addEventListener('focus', () => { if (input.value.trim()) run(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; hide(); input.blur(); }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-section')) hide();
  });
}

// Update DOM translation & scale
function updateTransform(options = {}) {
  const interactive = !!options.interactive;
  const vpWidth = canvasViewport.offsetWidth || window.innerWidth;
  const vpHeight = canvasViewport.offsetHeight || window.innerHeight;
  const cx = vpWidth / 2;
  const cy = vpHeight / 2;
  
  if (viewMode === '3d') {
    if (zoomSettleTimer) {
      clearTimeout(zoomSettleTimer);
      zoomSettleTimer = null;
    }
    canvasEl.style.zoom = '';
    canvasEl.classList.remove('layout-zoom-active');
    // Translate origin to screen center, rotate, move back to canvas offset, then scale
    canvasEl.style.transform = `translate(${cx}px, ${cy}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translate(${-cx + transformX}px, ${-cy + transformY}px) scale(${scale})`;
    drawAllConnections(); // Redraw connections as projection depends on transform
  } else if (interactive) {
    applyTransformZoom();
  } else if (supportsCrispLayoutZoom()) {
    const tx = layoutZoomTranslateUnscaled ? transformX : transformX / scale;
    const ty = layoutZoomTranslateUnscaled ? transformY : transformY / scale;
    const zoomValue = String(scale);
    if (canvasEl.style.zoom !== zoomValue) canvasEl.style.zoom = zoomValue;
    canvasEl.style.transform = `translate(${tx}px, ${ty}px)`;
    canvasEl.classList.add('layout-zoom-active');
  } else {
    applyTransformZoom();
  }
  updateMinimap();
}

// 3D Projection Math to map 3D canvas coordinates to 2D screen coordinates
function project3DPoint(x, y, z = 0) {
  const vpWidth = canvasViewport.offsetWidth || window.innerWidth;
  const vpHeight = canvasViewport.offsetHeight || window.innerHeight;
  const cx = vpWidth / 2;
  const cy = vpHeight / 2;
  
  // 1. Scale
  const x1 = x * scale;
  const y1 = y * scale;
  const z1 = z; // CSS scale() is 2D and does not scale the Z axis!
  
  // 2. Translate to origin based on current pan offset
  const x2 = x1 - cx + transformX;
  const y2 = y1 - cy + transformY;
  const z2 = z1;
  
  // 3. Rotate Y
  const ry = (rotateY * Math.PI) / 180;
  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);
  const x3 = x2 * cosY + z2 * sinY;
  const y3 = y2;
  const z3 = -x2 * sinY + z2 * cosY;
  
  // 4. Rotate X
  const rx = (rotateX * Math.PI) / 180;
  const cosX = Math.cos(rx);
  const sinX = Math.sin(rx);
  const x4 = x3;
  const y4 = y3 * cosX - z3 * sinX;
  const z4 = y3 * sinX + z3 * cosX;
  
  // 5. Perspective Projection
  const D = 1200; // perspective depth
  const divisor = D - z4;
  const factor = divisor > 100 ? D / divisor : D / 100;
  
  return {
    x: cx + x4 * factor,
    y: cy + y4 * factor
  };
}

// Redraw all connections (required for 3D camera movement)
function drawAllConnections() {
  if (flowMode) recomputeBranchColors();
  svgPathsGroup.innerHTML = '';
  connections3dEl.innerHTML = '';
  nodes.forEach(node => {
    if (node.parentId) {
      const parent = nodes.find(n => n.id === node.parentId);
      if (parent) {
        drawConnection(parent, node);
      }
    }
  });
}

// Toggle between 2D and 3D View modes
function setViewMode(mode) {
  if (mode === viewMode) return;
  viewMode = mode;
  
  const viewport = document.getElementById('canvas-viewport');
  const svg = document.getElementById('svg-connections');
  const btn = document.getElementById('view-mode-btn');
  const canvas = document.getElementById('canvas');
  if (svg && canvas && svg.parentElement !== canvas) {
    canvas.insertBefore(svg, canvas.firstChild);
  }
  
  if (mode === '3d') {
    viewport.classList.add('view-3d-active');
    rotateX = DEFAULT_3D_ROTATE_X;
    rotateY = DEFAULT_3D_ROTATE_Y;
    syncCardDepthTransforms();
    fitNodesInViewport(nodes, { maxScale: 0.9, padding: 96 });
    if (btn) {
      btn.classList.add('active');
      btn.innerText = '2D';
    }
  } else {
    viewport.classList.remove('view-3d-active');
    if (btn) {
      btn.classList.remove('active');
      btn.innerText = '3D';
    }
    
    // Reset canvas style through updateTransform so 2D can use crisp layout zoom.
    canvas.style.zoom = '';
    canvas.classList.remove('layout-zoom-active');
    
    // Reset card Z-transform visual
    syncCardDepthTransforms();
  }
  
  updateTransform();
  drawAllConnections();
}

// Setup listeners
function setupEventListeners() {
  // Helper selection functions
  function clearSelection() {
    clearCardSelection();
  }

  function selectNode(id) {
    setCardSelected(id, true);
    updateCardSizePanel();
  }

  setupCardSizePanel();

  // Mode Selection buttons
  document.getElementById('mode-select-btn').addEventListener('click', () => {
    setCanvasMode('select');
  });
  document.getElementById('mode-pan-btn').addEventListener('click', () => {
    setCanvasMode('pan');
  });

  // Hotkeys and Spacebar
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    const isUndo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey;
    const isRedo = ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
      ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z');
    if (isUndo) {
      e.preventDefault();
      undoHistory();
      return;
    }
    if (isRedo) {
      e.preventDefault();
      redoHistory();
      return;
    }

    if (e.key === 'Escape' && commentMode) {
      e.preventDefault();
      setCommentMode(false);
      return;
    }

    if (e.key === 'Escape' && manualLinkSourceNodeId) {
      e.preventDefault();
      cancelManualLinkMode();
      return;
    }

    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodeIds.length > 0) {
      e.preventDefault();
      deleteSelectedCards();
      return;
    }
    
    if (e.code === 'Space') {
      e.preventDefault();
      if (!spaceHeld) {
        spaceHeld = true;
        updateCursorMode();
      }
    } else if (e.key === 'v' || e.key === 'V') {
      setCanvasMode('select');
    } else if (e.key === 'h' || e.key === 'H') {
      setCanvasMode('pan');
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    if (e.code === 'Space') {
      spaceHeld = false;
      updateCursorMode();
    }
  });

  const viewModeBtn = document.getElementById('view-mode-btn');
  if (viewModeBtn) {
    viewModeBtn.addEventListener('click', () => {
      setViewMode(viewMode === '2d' ? '3d' : '2d');
    });
  }

  // Flatten every card on the current canvas back onto the same plane (Z=0)
  const flattenBtn = document.getElementById('flatten-btn');
  if (flattenBtn) {
    flattenBtn.addEventListener('click', () => {
      nodes.forEach(n => { n.z = 0; });
      syncCardDepthTransforms();
      drawAllConnections();
      saveBoard('拉回同一平面');
    });
  }

  const commentBtn = document.getElementById('comment-mode-btn');
  if (commentBtn) {
    commentBtn.addEventListener('click', () => setCommentMode(!commentMode));
  }

  // Toggle the canvas minimap navigator
  const navToggleBtn = document.getElementById('nav-toggle-btn');
  if (navToggleBtn) {
    navToggleBtn.addEventListener('click', () => {
      setMinimapVisible(!minimapVisible);
    });
  }

  // Toggle between the canvas and the scrollable chat-interface view
  const chatModeBtn = document.getElementById('chat-mode-btn');
  if (chatModeBtn) {
    chatModeBtn.addEventListener('click', () => {
      setChatMode(!chatMode);
    });
  }

  // Auto-arrange the canvas cards into a tidy non-overlapping tree
  const autoArrangeBtn = document.getElementById('auto-arrange-btn');
  if (autoArrangeBtn) {
    autoArrangeBtn.addEventListener('click', () => autoArrangeCanvas());
  }

  // Toggle the connection flow effect (animated, per-conversation colours)
  const flowToggleBtn = document.getElementById('flow-toggle-btn');
  if (flowToggleBtn) {
    flowToggleBtn.addEventListener('click', () => setFlowMode(!flowMode));
  }

  // Cycle the colour theme (dark / light / …)
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => cycleTheme());
  }

  // Toggle the left-to-right collapsible tree view
  const treeModeBtn = document.getElementById('tree-mode-btn');
  if (treeModeBtn) {
    treeModeBtn.addEventListener('click', () => {
      setTreeMode(!treeMode);
    });
  }

  // Tree sub-mode toggle (tree vs list-by-conversation) + conversation preview
  const subTreeBtn = document.getElementById('tree-sub-tree');
  const subConvosBtn = document.getElementById('tree-sub-convos');
  const treeNewChatBtn = document.getElementById('tree-new-chat');
  if (subTreeBtn) subTreeBtn.addEventListener('click', () => setTreeSubMode('tree'));
  if (subConvosBtn) subConvosBtn.addEventListener('click', () => setTreeSubMode('convos'));
  if (treeNewChatBtn) treeNewChatBtn.addEventListener('click', startConvoNewConversation);

  document.addEventListener('keydown', (e) => {
    if (convoPanelOpen) {
      if (e.target && e.target.closest && e.target.closest('#cp-follow-input')) return;
      if (e.key === 'Escape') closeConvoPreview();
      else if (e.key === 'ArrowLeft') convoPreviewStep(-1);
      else if (e.key === 'ArrowRight') convoPreviewStep(1);
    }
  });

  // Prevent context menu during 3D camera rotation
  canvasViewport.addEventListener('contextmenu', (e) => {
    if (viewMode === '3d') {
      e.preventDefault();
    }
  });

  // Canvas viewport panning, marquee selection, and camera rotation handlers
  canvasViewport.addEventListener('mousedown', (e) => {
    if (e.target.closest('.chat-card, .annotation, .canvas-controls, .mode-toolbar, .card-inspector, .history-panel')) return;

    if (manualLinkSourceNodeId) {
      e.preventDefault();
      cancelManualLinkMode();
      return;
    }

    if (commentMode) {
      e.preventDefault();
      const rect = canvasViewport.getBoundingClientRect();
      const x = (e.clientX - rect.left - transformX) / scale;
      const y = (e.clientY - rect.top - transformY) / scale;
      createAnnotationAt(x, y);
      return;
    }
    
    // Check if it's a camera rotation action in 3D mode (Right-click or Alt-Left-click)
    const isRotateAction = viewMode === '3d' && (e.button === 2 || (e.button === 0 && e.altKey));
    if (isRotateAction) {
      isRotatingCamera = true;
      rotateStartX = e.clientX;
      rotateStartY = e.clientY;
      initialRotateX = rotateX;
      initialRotateY = rotateY;
      canvasViewport.style.cursor = 'grabbing';
      return;
    }
    
    const isPanAction = canvasMode === 'pan' || spaceHeld;
    
    if (isPanAction) {
      // Start panning canvas
      isDraggingCanvas = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      canvasInitialX = transformX;
      canvasInitialY = transformY;
      canvasViewport.style.cursor = 'grabbing';
      
      // Deselect all cards when clicking empty canvas
      clearSelection();
    } else {
      if (viewMode === '3d') return; // Disable marquee selection in 3D
      
      // Start marquee selection
      isSelecting = true;
      const rect = canvasViewport.getBoundingClientRect();
      startSelX = (e.clientX - rect.left - transformX) / scale;
      startSelY = (e.clientY - rect.top - transformY) / scale;
      
      const marquee = document.getElementById('selection-marquee');
      if (marquee) {
        marquee.style.left = `${startSelX}px`;
        marquee.style.top = `${startSelY}px`;
        marquee.style.width = '0px';
        marquee.style.height = '0px';
        marquee.classList.remove('hidden');
      }
      
      // Clear previous selection unless Shift is held
      if (!e.shiftKey) {
        clearSelection();
      }
    }
  });

  document.addEventListener('mousemove', (e) => {
    if (isRotatingCamera) {
      const dx = e.clientX - rotateStartX;
      const dy = e.clientY - rotateStartY;
      
      rotateX = initialRotateX - dy * 0.25;
      rotateY = initialRotateY + dx * 0.25;
      
      rotateX = Math.max(-75, Math.min(75, rotateX)); // Constrain vertical flip
      
      updateTransform();
      drawAllConnections();
    } else if (isSelecting) {
      const rect = canvasViewport.getBoundingClientRect();
      const currSelX = (e.clientX - rect.left - transformX) / scale;
      const currSelY = (e.clientY - rect.top - transformY) / scale;
      
      const x = Math.min(startSelX, currSelX);
      const y = Math.min(startSelY, currSelY);
      const w = Math.abs(startSelX - currSelX);
      const h = Math.abs(startSelY - currSelY);
      
      const marquee = document.getElementById('selection-marquee');
      if (marquee) {
        marquee.style.left = `${x}px`;
        marquee.style.top = `${y}px`;
        marquee.style.width = `${w}px`;
        marquee.style.height = `${h}px`;
      }
      
      // Detect card overlaps
      nodes.forEach(node => {
        const el = document.getElementById(node.id);
        if (!el) return;
        const cardHeight = el.offsetHeight;
        const cardWidth = getCardWidth();
        
        const intersects = !(node.x > x + w || 
                              node.x + cardWidth < x || 
                              node.y > y + h || 
                              node.y + cardHeight < y);
                              
        if (intersects) {
          selectNode(node.id);
        } else {
          // Remove from selection
          const idx = selectedNodeIds.indexOf(node.id);
          if (idx > -1) {
            selectedNodeIds.splice(idx, 1);
            el.classList.remove('selected');
          }
        }
      });
      updateCardSizePanel();
    } else if (isDraggingCanvas) {
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      transformX = canvasInitialX + dx;
      transformY = canvasInitialY + dy;
      updateTransform();
    }
  });

  document.addEventListener('mouseup', () => {
    if (isRotatingCamera) {
      isRotatingCamera = false;
      updateCursorMode();
    }
    if (isSelecting) {
      const marquee = document.getElementById('selection-marquee');
      if (marquee) marquee.classList.add('hidden');
      isSelecting = false;
    }
    isDraggingCanvas = false;
    
    // Restore appropriate grab cursor
    if (!isRotatingCamera) updateCursorMode();
  });

  // Zoom on wheel scroll
  canvasViewport.addEventListener('wheel', (e) => {
    // In overlay views, let the wheel scroll the active content instead of zooming.
    if (
      chatMode ||
      treeMode ||
      e.target.closest('.annotation, .canvas-controls, .convo-preview, .modal-overlay, .preview-popover, .card-fullscreen, .card-inspector, .history-panel')
    ) return;
    e.preventDefault();
    const zoomIntensity = 0.06;
    
    // Zoom center coordinates (mouse cursor)
    const mouseX = e.clientX - canvasViewport.getBoundingClientRect().left;
    const mouseY = e.clientY - canvasViewport.getBoundingClientRect().top;
    
    const canvasX = (mouseX - transformX) / scale;
    const canvasY = (mouseY - transformY) / scale;
    
    const delta = -e.deltaY;
    let newScale = scale * (1 + (delta > 0 ? zoomIntensity : -zoomIntensity));
    newScale = Math.max(0.15, Math.min(3.0, newScale));
    
    transformX = mouseX - canvasX * newScale;
    transformY = mouseY - canvasY * newScale;
    scale = newScale;
    
    updateTransform({ interactive: true });
    settleCrispZoomSoon();
    updateZoomIndicator();
  });

  // Zoom controls
  document.getElementById('zoom-in-btn').addEventListener('click', () => {
    adjustZoom(1.2);
  });
  document.getElementById('zoom-out-btn').addEventListener('click', () => {
    adjustZoom(0.8);
  });
  document.getElementById('zoom-reset-btn').addEventListener('click', () => {
    if (viewMode === '3d') {
      rotateX = DEFAULT_3D_ROTATE_X;
      rotateY = DEFAULT_3D_ROTATE_Y;
      fitNodesInViewport(nodes, { maxScale: 0.9, padding: 96 });
    } else {
      scale = 1.0;
      // Recenter
      transformX = -25000 + (canvasViewport.offsetWidth) / 2;
      transformY = -25000 + canvasViewport.offsetHeight / 2;
      updateTransform();
      updateZoomIndicator();
    }
  });

  // AI Provider settings toggle fields
  const providerSelect = document.getElementById('ai-provider');
  const toggleConfigBtn = document.getElementById('toggle-config-btn');
  const saveConfigBtn = document.getElementById('save-config-btn');

  providerSelect.addEventListener('change', () => {
    config.provider = providerSelect.value;
    if (config.provider === 'mock') {
      apiKeysContainer.classList.remove('show');
      if (toggleConfigBtn) toggleConfigBtn.classList.add('hidden');
    } else {
      apiKeysContainer.classList.add('show');
      if (toggleConfigBtn) toggleConfigBtn.classList.remove('hidden');
    }
    updateStatusIndicator();
    saveConfig();
  });

  if (toggleConfigBtn) {
    toggleConfigBtn.addEventListener('click', () => {
      apiKeysContainer.classList.toggle('show');
    });
  }

  if (saveConfigBtn) {
    saveConfigBtn.addEventListener('click', () => {
      apiKeysContainer.classList.remove('show');
    });
  }

  // Input changes - save on input for instant autosaving, and update status indicators
  document.getElementById('api-key').addEventListener('input', (e) => {
    config.apiKey = e.target.value;
    saveConfig();
  });
  document.getElementById('api-endpoint').addEventListener('input', (e) => {
    config.endpoint = e.target.value || 'https://generativelanguage.googleapis.com';
    saveConfig();
  });
  document.getElementById('api-model').addEventListener('input', (e) => {
    config.model = e.target.value || 'gemini-1.5-flash';
    saveConfig();
    updateStatusIndicator();
  });

  // Language Toggle
  document.getElementById('lang-toggle-btn').addEventListener('click', () => {
    currentLang = currentLang === 'zh' ? 'en' : 'zh';
    localStorage.setItem('mindchat_lang', currentLang);
    applyTranslations();
    renderBoard();
  });

  // Sidebar collapse/expand — two controls (bottom bar + edge tab) stay in sync.
  const sidebar = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle-btn');
  const edgeToggle = document.getElementById('sidebar-edge-toggle');
  const toggleSidebar = () => {
    sidebarCollapsed = !sidebarCollapsed;
    sidebar.classList.toggle('collapsed', sidebarCollapsed);
    document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
    if (toggleBtn) toggleBtn.innerText = sidebarCollapsed ? '▶' : '◀';
    if (edgeToggle) edgeToggle.innerText = sidebarCollapsed ? '▶' : '◀';
  };
  if (toggleBtn) toggleBtn.addEventListener('click', toggleSidebar);
  if (edgeToggle) edgeToggle.addEventListener('click', toggleSidebar);

  // Fullscreen card reader close handlers
  const cfOverlay = document.getElementById('card-fullscreen');
  const cfClose = document.getElementById('cf-close');
  if (cfClose) cfClose.addEventListener('click', closeCardFullscreen);
  if (cfOverlay) cfOverlay.addEventListener('click', (e) => {
    if (e.target === cfOverlay) closeCardFullscreen();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeCardFullscreen();
      closeDiagnosticsModal();
    }
  });

  // Modal actions
  const importModal = document.getElementById('import-modal');
  document.getElementById('import-log-btn').addEventListener('click', () => {
    importModal.classList.remove('hidden');
    document.getElementById('import-data').value = '';
  });

  document.getElementById('import-modal-close').addEventListener('click', () => {
    importModal.classList.add('hidden');
  });
  document.getElementById('import-cancel-btn').addEventListener('click', () => {
    importModal.classList.add('hidden');
  });

  const diagnosticsBtn = document.getElementById('diagnostics-btn');
  const diagnosticsClose = document.getElementById('diagnostics-close-btn');
  const diagnosticsModalClose = document.getElementById('diagnostics-modal-close');
  const diagnosticsRefresh = document.getElementById('diagnostics-refresh-btn');
  const diagnosticsMirror = document.getElementById('diagnostics-mirror-btn');
  if (diagnosticsBtn) diagnosticsBtn.addEventListener('click', openDiagnosticsModal);
  if (diagnosticsClose) diagnosticsClose.addEventListener('click', closeDiagnosticsModal);
  if (diagnosticsModalClose) diagnosticsModalClose.addEventListener('click', closeDiagnosticsModal);
  if (diagnosticsRefresh) diagnosticsRefresh.addEventListener('click', renderDiagnostics);
  if (diagnosticsMirror) diagnosticsMirror.addEventListener('click', mirrorLocalMindChatDataToIndexedDb);

  document.getElementById('import-submit-btn').addEventListener('click', () => {
    const text = document.getElementById('import-data').value;
    const format = document.getElementById('parser-type').value;
    const arrange = document.getElementById('import-arrange').checked;
    handleChatLogImport(text, format, arrange);
  });

  // Operations
  document.getElementById('add-folder-btn').addEventListener('click', () => {
    const name = prompt(translations[currentLang].folderPrompt);
    if (!name || name.trim() === '') return;

    library.push({
      id: 'folder_' + Date.now(),
      name: name.trim(),
      canvases: []
    });

    saveLibrary();
    renderExplorerTree();
  });

  document.getElementById('add-node-btn').addEventListener('click', () => {
    const id = `node_${Date.now()}`;
    const position = getNextBlankCardPosition();
    nodes.push({
      id,
      parentId: null,
      role: 'user',
      content: translations[currentLang].doubleClickEdit,
      x: position.x,
      y: position.y,
      z: position.z,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    });
    saveBoard('新建卡片');
    rememberActiveNode(id);
    selectCardNode(id);
    renderBoard();
    if (cardLayout === 'wide') arrangeVertical();
    focusOnNode(id);
  });

  document.getElementById('clear-board-btn').addEventListener('click', () => {
    if (confirm(translations[currentLang].clearConfirm)) {
      nodes = [];
      knowledgeEdges = [];
      annotations = [];
      saveAnnotations('清空批注');
      saveKnowledgeEdges();
      saveBoard('清空画布');
      renderBoard();
    }
  });

  // JSON files operations
  const fileInput = document.getElementById('file-input');
  const backupFileInput = document.getElementById('backup-file-input');
  document.getElementById('export-json-btn').addEventListener('click', () => {
    const exportData = { nodes, annotations, knowledgeEdges };
    downloadJsonFile(exportData, `mindchat-canvas-${Date.now()}.json`);
  });

  const exportKnowledgeBtn = document.getElementById('export-knowledge-btn');
  if (exportKnowledgeBtn) exportKnowledgeBtn.addEventListener('click', exportKnowledgeInput);

  const linkKnowledgeBtn = document.getElementById('link-knowledge-btn');
  if (linkKnowledgeBtn) linkKnowledgeBtn.addEventListener('click', linkCurrentKnowledgeCards);

  document.getElementById('import-json-btn').addEventListener('click', () => {
    fileInput.click();
  });

  const exportBackupBtn = document.getElementById('export-backup-btn');
  const importBackupBtn = document.getElementById('import-backup-btn');
  if (exportBackupBtn) exportBackupBtn.addEventListener('click', exportWorkspaceBackup);
  if (importBackupBtn && backupFileInput) {
    importBackupBtn.addEventListener('click', () => {
      backupFileInput.click();
    });
  }

  if (backupFileInput) {
    backupFileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      readJsonFile(file, async (parsed) => {
        try {
          await restoreWorkspaceBackup(parsed);
        } catch (err) {
          console.error(err);
          alert(currentLang === 'zh'
            ? '恢复完整备份失败，请确认文件是否正确。'
            : 'Failed to restore the workspace backup. Please check the file.');
        } finally {
          backupFileInput.value = '';
        }
      });
    });
  }

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const isTextFile = file.name.endsWith('.txt') || file.name.endsWith('.log');
    const isKnowledgeFile = /\.(md|markdown|docx)$/i.test(file.name);

    if (isKnowledgeFile) {
      analyzeFileWithBridge(file).catch(err => {
        console.error(err);
        alert(currentLang === 'zh'
          ? `知识文件导入失败：${err.message}。请先启动 bridge/server.py。`
          : `Knowledge import failed: ${err.message}. Start bridge/server.py first.`);
      }).finally(() => { fileInput.value = ''; });
      return;
    }

    const reader = new FileReader();
    reader.onload = async function(event) {
      const fileContent = event.target.result;

      if (isTextFile) {
        // Direct import of text chat log
        handleChatLogImport(fileContent, 'auto', true);
        fileInput.value = ''; // Reset input
        return;
      }

      try {
        const parsed = JSON.parse(fileContent);
        if (isWorkspaceBackup(parsed)) {
          await restoreWorkspaceBackup(parsed);
          fileInput.value = '';
          return;
        }
        if (isKnowledgeImportData(parsed)) {
          importKnowledgeData(parsed, file.name);
          fileInput.value = '';
          return;
        }
        let isBoardSave = false;
        let importedNodes = [];
        let importedAnnotations = [];

        if (Array.isArray(parsed)) {
          isBoardSave = parsed.length > 0 && ('x' in parsed[0]) && ('y' in parsed[0]);
          importedNodes = parsed;
        } else if (parsed && Array.isArray(parsed.nodes)) {
          isBoardSave = parsed.nodes.length === 0 || parsed.nodes.some(item => item && ('x' in item) && ('y' in item));
          importedNodes = parsed.nodes;
          importedAnnotations = Array.isArray(parsed.annotations) ? parsed.annotations : [];
        }

        if (isBoardSave) {
          nodes = importedNodes;
          annotations = importedAnnotations;
          knowledgeEdges = Array.isArray(parsed.knowledgeEdges) ? parsed.knowledgeEdges : [];
          saveAnnotations('导入画布批注');
          saveKnowledgeEdges();
          saveBoard('导入画布');
          renderBoard();
          if (nodes.length > 0) centerOnNode(nodes[0].id);
        } else {
          // It's a JSON chat log (either array or object structure), import as cards onto the active board
          handleChatLogImport(fileContent, 'json', true);
        }
      } catch (err) {
        // Fallback to text parsing if JSON parse failed
        if (confirm('解析 JSON 失败，是否尝试将其作为纯文本聊天日志导入？')) {
          handleChatLogImport(fileContent, 'auto', true);
        }
      }
      fileInput.value = ''; // Reset input
    };
    reader.readAsText(file);
  });
}

// Utility zoom helpers
function adjustZoom(factor) {
  const mouseX = canvasViewport.offsetWidth / 2;
  const mouseY = canvasViewport.offsetHeight / 2;
  
  const canvasX = (mouseX - transformX) / scale;
  const canvasY = (mouseY - transformY) / scale;
  
  let newScale = scale * factor;
  newScale = Math.max(0.15, Math.min(3.0, newScale));
  
  transformX = mouseX - canvasX * newScale;
  transformY = mouseY - canvasY * newScale;
  scale = newScale;
  
  updateTransform({ interactive: true });
  settleCrispZoomSoon();
  updateZoomIndicator();
}

function updateZoomIndicator() {
  document.getElementById('zoom-reset-btn').innerText = `${Math.round(scale * 100)}%`;
}

function updateStatusIndicator() {
  const indicator = document.getElementById('status-indicator');
  if (!indicator) return;
  indicator.innerHTML = '';
  const dot = document.createElement('span');
  
  if (config.provider === 'mock') {
    dot.className = 'status-dot green';
    indicator.appendChild(dot);
    indicator.appendChild(document.createTextNode(` ${translations[currentLang].statusReady}`));
  } else {
    dot.className = 'status-dot orange';
    const activeModel = config.model || 'gemini-1.5-flash';
    indicator.appendChild(dot);
    indicator.appendChild(document.createTextNode(` ${translations[currentLang].statusApi} (${activeModel})`));
  }
}

function getScriptVersion(fileName) {
  const script = Array.from(document.scripts).find(item => item.src.includes(fileName));
  if (!script) return 'not loaded';
  try {
    const url = new URL(script.src, window.location.href);
    return url.searchParams.get('v') || 'unversioned';
  } catch (e) {
    return 'unknown';
  }
}

function getStorageApproxBytes(prefix = 'mindchat_') {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    const value = localStorage.getItem(key) || '';
    total += key.length + value.length;
  }
  return total * 2;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function canWriteLocalStorageProbe() {
  const key = 'mindchat_diagnostics_probe';
  try {
    localStorage.setItem(key, '1');
    localStorage.removeItem(key);
    return true;
  } catch (e) {
    return false;
  }
}

function getLocalStorageKeys(prefix = 'mindchat_') {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    keys.push(key);
  }
  return keys;
}

async function createWorkspaceBackup() {
  const localStorageData = {};
  getLocalStorageKeys('mindchat_').forEach(key => {
    localStorageData[key] = localStorage.getItem(key);
  });

  const indexedDbData = {};
  if (storageModule.indexedDb.isAvailable()) {
    const idbKeys = await storageModule.indexedDb.keys('mindchat_');
    await Promise.all(idbKeys.map(async key => {
      indexedDbData[key] = await storageModule.indexedDb.get(key);
    }));
  }

  return {
    format: 'mindchat-workspace-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    activeCanvasId,
    localStorage: localStorageData,
    indexedDb: indexedDbData
  };
}

function isWorkspaceBackup(data) {
  return !!data
    && data.format === 'mindchat-workspace-backup'
    && data.version === 1
    && data.localStorage
    && typeof data.localStorage === 'object';
}

function downloadJsonFile(data, filename) {
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 2));
  const dlAnchorElem = document.createElement('a');
  dlAnchorElem.setAttribute('href', dataStr);
  dlAnchorElem.setAttribute('download', filename);
  dlAnchorElem.click();
}

async function exportWorkspaceBackup() {
  try {
    const backup = await createWorkspaceBackup();
    downloadJsonFile(backup, `mindchat-workspace-backup-${Date.now()}.json`);
  } catch (err) {
    console.error(err);
    alert(currentLang === 'zh'
      ? '导出完整备份失败，请查看控制台。'
      : 'Failed to export the workspace backup. Please check the console.');
  }
}

async function replaceMindChatStorageFromBackup(backup) {
  const localKeys = getLocalStorageKeys('mindchat_');
  localKeys.forEach(key => localStorage.removeItem(key));

  if (storageModule.indexedDb.isAvailable()) {
    const idbKeys = await storageModule.indexedDb.keys('mindchat_');
    await Promise.all(idbKeys.map(key => storageModule.indexedDb.remove(key)));
  }

  Object.entries(backup.localStorage || {}).forEach(([key, value]) => {
    if (!key.startsWith('mindchat_')) return;
    localStorage.setItem(key, value == null ? '' : String(value));
  });

  const indexedDbEntries = Object.entries(backup.indexedDb || {});
  if (storageModule.indexedDb.isAvailable()) {
    if (indexedDbEntries.length > 0) {
      await Promise.all(indexedDbEntries.map(([key, value]) => {
        if (!key.startsWith('mindchat_')) return Promise.resolve();
        return storageModule.indexedDb.set(key, value == null ? '' : String(value));
      }));
    } else {
      await storageModule.indexedDb.migrateLocalStorageKeys('mindchat_');
    }
  }
}

async function restoreWorkspaceBackup(backup, options = {}) {
  if (!isWorkspaceBackup(backup)) {
    throw new Error('Invalid MindChat workspace backup.');
  }
  const confirmed = options.skipConfirm || confirm(currentLang === 'zh'
    ? '恢复完整备份会替换当前所有 MindChat 本地工作区数据。继续吗？'
    : 'Restoring a full backup will replace all current MindChat local workspace data. Continue?');
  if (!confirmed) return false;

  await replaceMindChatStorageFromBackup(backup);
  library = [];
  activeCanvasId = backup.activeCanvasId || null;
  collapsedFolderIds = [];
  hasLoadedCanvas = false;
  loadLibrary();
  renderExplorerTree();
  renderBoard();
  renderDiagnostics();
  if (!options.silent) {
    alert(currentLang === 'zh'
      ? '完整备份已恢复。'
      : 'Workspace backup restored.');
  }
  return true;
}

function readJsonFile(file, onLoad) {
  const reader = new FileReader();
  reader.onload = function(event) {
    try {
      onLoad(JSON.parse(event.target.result));
    } catch (err) {
      console.error(err);
      alert(currentLang === 'zh'
        ? '无法解析 JSON 文件。'
        : 'Could not parse the JSON file.');
    }
  };
  reader.readAsText(file);
}

function getDiagnosticsRows() {
  const boardSnapshot = serializeBoardState();
  const configRaw = localStorage.getItem('mindchat_config') || '{}';
  let localConfigHasApiKey = false;
  try {
    localConfigHasApiKey = Object.prototype.hasOwnProperty.call(JSON.parse(configRaw), 'apiKey');
  } catch (e) {}
  const localStorageWritable = canWriteLocalStorageProbe();

  return [
    ['Security module', window.MindChatModules && window.MindChatModules.createSecurityModule ? `loaded (${getScriptVersion('scripts/security.js')})` : 'missing', 'ok'],
    ['Storage module', window.MindChatModules && window.MindChatModules.createStorageModule ? `loaded (${getScriptVersion('scripts/storage.js')})` : 'missing', 'ok'],
    ['Chat module', window.MindChatModules && window.MindChatModules.createChatModule ? `loaded (${getScriptVersion('scripts/chat.js')})` : 'missing', 'ok'],
    ['App script', getScriptVersion('app.js'), 'ok'],
    ['IndexedDB available', storageModule.indexedDb.isAvailable() ? 'yes' : 'no', storageModule.indexedDb.isAvailable() ? 'ok' : 'warn'],
    ['IndexedDB read priority', 'primary with localStorage preview/fallback', 'ok'],
    ['Active canvas', activeCanvasId || 'none', activeCanvasId ? 'ok' : 'warn'],
    ['Cards on canvas', String(nodes.length), 'ok'],
    ['Annotations', String(annotations.length), 'ok'],
    ['Board snapshot size', formatBytes(boardSnapshot.length * 2), 'ok'],
    ['MindChat local storage', formatBytes(getStorageApproxBytes()), 'ok'],
    ['Local storage writable', localStorageWritable ? 'yes' : 'no', localStorageWritable ? 'ok' : 'warn'],
    ['API key in localStorage', localConfigHasApiKey ? 'yes (legacy risk)' : 'no', localConfigHasApiKey ? 'warn' : 'ok'],
    ['API key in session', config.apiKey ? 'present' : 'not set', config.apiKey ? 'ok' : 'warn'],
    ['Provider', config.provider || 'mock', 'ok'],
    ['Model', config.model || 'default', 'ok']
  ];
}

function formatCanvasMirrorStatus(key, idbValue) {
  const localValue = localStorage.getItem(key);
  if (localValue === null && idbValue === null) {
    return ['missing in both stores', 'warn'];
  }
  if (localValue !== null && idbValue === null) {
    return ['local only - run mirror sync', 'warn'];
  }
  if (localValue === null && idbValue !== null) {
    return ['IndexedDB only - will restore local preview', 'ok'];
  }
  if (localValue === idbValue) {
    return ['in sync', 'ok'];
  }
  return ['differs - IndexedDB will overwrite local preview', 'warn'];
}

async function getDiagnosticsAsyncRows() {
  if (!storageModule.indexedDb.isAvailable()) {
    return [
      ['IndexedDB mirror coverage', 'unavailable', 'warn']
    ];
  }

  const localKeys = getLocalStorageKeys('mindchat_');
  const idbKeys = await storageModule.indexedDb.keys('mindchat_');
  const idbKeySet = new Set(idbKeys);
  const missingMirrorKeys = localKeys.filter(key => !idbKeySet.has(key));
  const coverageLabel = localKeys.length === 0
    ? `0 local keys (${idbKeys.length} IndexedDB keys)`
    : `${localKeys.length - missingMirrorKeys.length}/${localKeys.length} local keys mirrored`;
  const rows = [
    ['IndexedDB mirror coverage', missingMirrorKeys.length === 0 ? coverageLabel : `${coverageLabel}; ${missingMirrorKeys.length} missing`, missingMirrorKeys.length === 0 ? 'ok' : 'warn']
  ];

  if (!activeCanvasId) {
    rows.push(['Current board mirror', 'no active canvas', 'warn']);
    rows.push(['Current annotations mirror', 'no active canvas', 'warn']);
    return rows;
  }

  const boardKey = 'mindchat_board_' + activeCanvasId;
  const annotationsKey = 'mindchat_annotations_' + activeCanvasId;
  const [boardMirror, annotationsMirror] = await Promise.all([
    storageModule.indexedDb.get(boardKey),
    storageModule.indexedDb.get(annotationsKey)
  ]);
  rows.push(['Current board mirror', ...formatCanvasMirrorStatus(boardKey, boardMirror)]);
  rows.push(['Current annotations mirror', ...formatCanvasMirrorStatus(annotationsKey, annotationsMirror)]);
  return rows;
}

let diagnosticsRenderToken = 0;

function appendDiagnosticsRow(grid, label, value, tone) {
  const labelEl = document.createElement('div');
  labelEl.className = 'diagnostics-label';
  labelEl.textContent = label;

  const valueEl = document.createElement('div');
  valueEl.className = `diagnostics-value ${tone || ''}`.trim();
  valueEl.textContent = value;

  grid.appendChild(labelEl);
  grid.appendChild(valueEl);
}

function renderDiagnostics() {
  const grid = document.getElementById('diagnostics-grid');
  if (!grid) return;
  diagnosticsRenderToken += 1;
  const token = diagnosticsRenderToken;
  grid.innerHTML = '';
  getDiagnosticsRows().forEach(([label, value, tone]) => {
    appendDiagnosticsRow(grid, label, value, tone);
  });
  appendDiagnosticsRow(grid, 'Mirror validation', 'checking...', 'warn');

  getDiagnosticsAsyncRows().then(rows => {
    if (token !== diagnosticsRenderToken) return;
    const nextRows = [
      ...getDiagnosticsRows(),
      ...rows
    ];
    grid.innerHTML = '';
    nextRows.forEach(([label, value, tone]) => {
      appendDiagnosticsRow(grid, label, value, tone);
    });
  }).catch(err => {
    console.error(err);
    if (token !== diagnosticsRenderToken) return;
    appendDiagnosticsRow(grid, 'Mirror validation', 'failed - check console', 'warn');
  });
}

function openDiagnosticsModal() {
  renderDiagnostics();
  const modal = document.getElementById('diagnostics-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeDiagnosticsModal() {
  const modal = document.getElementById('diagnostics-modal');
  if (modal) modal.classList.add('hidden');
}

async function mirrorLocalMindChatDataToIndexedDb() {
  const btn = document.getElementById('diagnostics-mirror-btn');
  if (btn) btn.disabled = true;
  try {
    const keys = await storageModule.indexedDb.migrateLocalStorageKeys('mindchat_');
    alert(currentLang === 'zh'
      ? `已同步 ${keys.length} 个本地数据项到 IndexedDB 镜像。`
      : `Synced ${keys.length} local data item(s) to the IndexedDB mirror.`);
    renderDiagnostics();
  } catch (err) {
    console.error(err);
    alert(currentLang === 'zh'
      ? '同步 IndexedDB 镜像失败，请查看控制台。'
      : 'Failed to sync the IndexedDB mirror. Please check the console.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Config file local storage
function saveConfig() {
  storageModule.saveConfig(config);
}

function setCanvasMode(mode) {
  canvasMode = mode;
  if (mode !== 'select') setCommentMode(false);
  document.querySelectorAll('.mode-btn').forEach(btn => btn.classList.remove('active'));
  
  const selectBtn = document.getElementById('mode-select-btn');
  const panBtn = document.getElementById('mode-pan-btn');
  if (mode === 'select' && selectBtn) selectBtn.classList.add('active');
  if (mode === 'pan' && panBtn) panBtn.classList.add('active');
  
  updateCursorMode();
}

function setCommentMode(enabled) {
  commentMode = !!enabled;
  document.body.classList.toggle('comment-mode', commentMode);
  const btn = document.getElementById('comment-mode-btn');
  if (btn) btn.classList.toggle('active', commentMode);
  if (commentMode) {
    canvasMode = 'select';
    document.querySelectorAll('.mode-btn').forEach(item => item.classList.remove('active'));
    const selectBtn = document.getElementById('mode-select-btn');
    if (selectBtn) selectBtn.classList.add('active');
  }
  updateCursorMode();
}

function updateCursorMode() {
  if (manualLinkSourceNodeId) {
    canvasViewport.style.cursor = 'crosshair';
    canvasViewport.classList.remove('pan-mode-active');
    return;
  }

  if (commentMode) {
    canvasViewport.style.cursor = 'copy';
    canvasViewport.classList.remove('pan-mode-active');
    return;
  }

  const isPan = canvasMode === 'pan' || spaceHeld;
  if (isPan) {
    canvasViewport.style.cursor = 'grab';
    canvasViewport.classList.add('pan-mode-active');
  } else {
    canvasViewport.style.cursor = 'default';
    canvasViewport.classList.remove('pan-mode-active');
  }
}

function loadConfig() {
  config = storageModule.loadConfig(config);

  // Update DOM fields
  document.getElementById('ai-provider').value = config.provider;
  document.getElementById('api-key').value = config.apiKey || '';
  document.getElementById('api-endpoint').value = config.endpoint || 'https://generativelanguage.googleapis.com';
  document.getElementById('api-model').value = config.model || 'gemini-1.5-flash';

  const toggleConfigBtn = document.getElementById('toggle-config-btn');
  if (config.provider !== 'mock') {
    // Keep collapsed on load but show edit toggle button
    apiKeysContainer.classList.remove('show');
    if (toggleConfigBtn) toggleConfigBtn.classList.remove('hidden');
  } else {
    if (toggleConfigBtn) toggleConfigBtn.classList.add('hidden');
  }
  updateStatusIndicator();
}

// Board state local storage - modified to store per active canvas ID
function saveBoard(label = '') {
  if (activeCanvasId) {
    if (label) markHistory(label);
    const snapshot = serializeBoardState();

    if (!historyPaused) {
      if (historySnapshot === null) {
        historySnapshot = snapshot;
      } else if (historySnapshot !== snapshot) {
        pushHistoryEntry(historySnapshot, snapshot, historyPendingLabel || '修改白板');
        historySnapshot = snapshot;
      }
    }

    historyPendingLabel = '';
    safeLocalStorageSet('mindchat_board_' + activeCanvasId, snapshot, { critical: true });
    updateHistoryUI();
  }
}

function migrateOldNodes(nodesList) {
  let migrated = false;
  // Make a shallow copy of nodesList to iterate safely
  const listCopy = [...nodesList];
  for (let i = 0; i < listCopy.length; i++) {
    const node = listCopy[i];
    if (node.role === 'user' && node.content && node.content.length <= 500 && node.question === undefined) {
      // Find children of this user node
      const children = listCopy.filter(n => n.parentId === node.id);
      // Find the first assistant/model child
      const assistantChild = children.find(n => n.role === 'assistant' || n.role === 'model');
      if (assistantChild) {
        // Merge the user node into the assistant node
        const realNode = nodesList.find(n => n.id === assistantChild.id);
        if (realNode) {
          realNode.role = 'dialogue';
          realNode.question = node.content;
          realNode.parentId = node.parentId;
          realNode.x = node.x;
          realNode.y = node.y;
          
          // Remove the user node from the actual nodes list
          const userIdx = nodesList.findIndex(n => n.id === node.id);
          if (userIdx !== -1) {
            nodesList.splice(userIdx, 1);
          }
          
          // Update parent of any other children of the user node to point to the merged card
          children.forEach(c => {
            if (c.id !== assistantChild.id) {
              const childNode = nodesList.find(n => n.id === c.id);
              if (childNode) {
                childNode.parentId = assistantChild.id;
              }
            }
          });
          
          migrated = true;
        }
      }
    }
  }
  return migrated;
}

async function hydrateBoardFromIndexedDb(canvasId, token, options = {}) {
  const { preferIndexedDb = false } = options;
  if (!canvasId || token !== storageHydrationToken) return false;
  const key = 'mindchat_board_' + canvasId;
  const saved = await storageModule.indexedDb.get(key).catch(err => {
    console.warn('Failed to read board from IndexedDB mirror:', err);
    return null;
  });
  if (!saved || token !== storageHydrationToken || canvasId !== activeCanvasId) {
    return false;
  }
  if (!preferIndexedDb && localStorage.getItem(key)) {
    return false;
  }

  try {
    const restoredNodes = JSON.parse(saved);
    if (!Array.isArray(restoredNodes)) return false;
    nodes = restoredNodes;
    if (migrateOldNodes(nodes)) {
      safeLocalStorageSet(key, JSON.stringify(nodes), { critical: true });
    } else {
      safeLocalStorageSet(key, saved, { critical: true });
    }
    setHistoryBaseline();
    renderBoard();
    if (nodes.length > 0) focusOnNode(nodes[0].id);
    return true;
  } catch (err) {
    console.warn('Failed to hydrate board from IndexedDB mirror:', err);
    return false;
  }
}

async function hydrateAnnotationsFromIndexedDb(canvasId, token, options = {}) {
  const { preferIndexedDb = false } = options;
  if (!canvasId || token !== storageHydrationToken) return false;
  const key = 'mindchat_annotations_' + canvasId;
  const saved = await storageModule.indexedDb.get(key).catch(err => {
    console.warn('Failed to read annotations from IndexedDB mirror:', err);
    return null;
  });
  if (!saved || token !== storageHydrationToken || canvasId !== activeCanvasId) {
    return false;
  }
  if (!preferIndexedDb && localStorage.getItem(key)) {
    return false;
  }

  try {
    const restoredAnnotations = JSON.parse(saved);
    if (!Array.isArray(restoredAnnotations)) return false;
    annotations = restoredAnnotations;
    safeLocalStorageSet(key, saved, { critical: true });
    renderAnnotations();
    return true;
  } catch (err) {
    console.warn('Failed to hydrate annotations from IndexedDB mirror:', err);
    return false;
  }
}

function loadBoard() {
  storageHydrationToken += 1;
  const token = storageHydrationToken;
  activeAnnotationDraftId = null;
  setCommentMode(false);
  if (activeCanvasId) {
    const saved = localStorage.getItem('mindchat_board_' + activeCanvasId);
    if (saved) {
      try {
        nodes = JSON.parse(saved);
        if (migrateOldNodes(nodes)) {
          safeLocalStorageSet('mindchat_board_' + activeCanvasId, JSON.stringify(nodes), { critical: true });
        }
      } catch (e) {
        console.error(e);
        nodes = [];
      }
    } else {
      nodes = [];
    }
    hydrateBoardFromIndexedDb(activeCanvasId, token, { preferIndexedDb: true });
  } else {
    nodes = [];
  }
  loadKnowledgeEdges();
  loadAnnotations();
  setHistoryBaseline();
}

// Library explorer variables
let library = [];
let activeCanvasId = null;
let collapsedFolderIds = [];
let hasLoadedCanvas = false; // guards against saving an empty board over the
                             // active canvas on the very first load
let storageHydrationToken = 0;

// Save Library metadata
function saveLibrary() {
  safeLocalStorageSet('mindchat_library', JSON.stringify(library), { critical: true });
  safeLocalStorageSet('mindchat_active_canvas_id', activeCanvasId || '');
  safeLocalStorageSet('mindchat_collapsed_folders', JSON.stringify(collapsedFolderIds));
}

// Load Library metadata
function loadLibrary() {
  const savedLang = localStorage.getItem('mindchat_lang');
  if (savedLang) {
    currentLang = savedLang;
  } else {
    const navLang = navigator.language || navigator.userLanguage;
    currentLang = navLang.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  const savedLib = localStorage.getItem('mindchat_library');
  const savedActiveId = localStorage.getItem('mindchat_active_canvas_id');
  const savedCollapsed = localStorage.getItem('mindchat_collapsed_folders');

  if (savedCollapsed) {
    try { collapsedFolderIds = JSON.parse(savedCollapsed); } catch(e) {}
  }

  if (savedLib) {
    try {
      library = JSON.parse(savedLib);
      activeCanvasId = savedActiveId;
    } catch(e) {
      console.error(e);
    }
  }

  // Initialize library if empty
  if (!library || library.length === 0) {
    const defFolderId = 'folder_' + Date.now();
    const defCanvasId = 'canvas_welcome';
    
    library = [{
      id: defFolderId,
      name: translations[currentLang].defaultProject,
      canvases: [{
        id: defCanvasId,
        name: translations[currentLang].defaultCanvas
      }]
    }];
    
    activeCanvasId = defCanvasId;
    
    // Save tutorial welcome cards to localStorage immediately so it loads successfully
    const rootId = 'welcome_dialogue';
    const welcomeNodes = [
      {
        id: rootId,
        parentId: null,
        role: 'dialogue',
        question: translations[currentLang].welcomeUser,
        content: translations[currentLang].welcomeAi,
        x: 25000 - 150,
        y: 25000 - 100,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ];
    safeLocalStorageSet('mindchat_board_' + defCanvasId, JSON.stringify(welcomeNodes), { critical: true });
    safeLocalStorageSet('mindchat_annotations_' + defCanvasId, JSON.stringify([]), { critical: true });
    safeLocalStorageSet('mindchat_knowledge_edges_' + defCanvasId, JSON.stringify([]), { critical: true });
    saveLibrary();
  }

  // If active canvas is deleted or null, set to first available canvas
  if (!activeCanvasId || !findCanvas(activeCanvasId)) {
    const firstCanvas = getFirstCanvas();
    activeCanvasId = firstCanvas ? firstCanvas.id : null;
    saveLibrary();
  }

  applyTranslations(); // Apply UI translation
  loadCanvas(activeCanvasId);
}

function findCanvas(canvasId) {
  for (const f of library) {
    const c = f.canvases.find(item => item.id === canvasId);
    if (c) return c;
  }
  return null;
}

function getFirstCanvas() {
  for (const f of library) {
    if (f.canvases.length > 0) return f.canvases[0];
  }
  return null;
}

// Load a specific canvas
function loadCanvas(canvasId) {
  // Save the canvas we're leaving first — but not on the initial load, where
  // `nodes` is still empty and would otherwise overwrite the saved board.
  if (hasLoadedCanvas) saveBoard();

  // Set new active canvas
  activeCanvasId = canvasId;
  loadBoard();
  hasLoadedCanvas = true;

  saveLibrary();
  renderBoard();
  renderExplorerTree();
  
  // Focus on first node or center
  if (nodes.length > 0) {
    focusOnNode(nodes[0].id);
  } else {
    // Recenter
    transformX = -25000 + (canvasViewport.offsetWidth) / 2;
    transformY = -25000 + canvasViewport.offsetHeight / 2;
    updateTransform();
  }
}

// Render the Folder/Canvas explorer tree
function renderExplorerTree() {
  const treeEl = document.getElementById('explorer-tree');
  if (!treeEl) return;
  
  treeEl.innerHTML = '';
  
  library.forEach(folder => {
    const isCollapsed = collapsedFolderIds.includes(folder.id);
    
    // Folder Node
    const folderEl = document.createElement('div');
    folderEl.className = `folder-node${isCollapsed ? ' collapsed' : ''}`;
    
    // Folder Header row
    const headerEl = document.createElement('div');
    headerEl.className = 'folder-header';
    
    // Title container (left side)
    const titleContainer = document.createElement('div');
    titleContainer.className = 'folder-title-container';
    
    const arrow = document.createElement('span');
    arrow.className = 'folder-arrow';
    arrow.innerText = '▼';
    
    const icon = document.createElement('span');
    icon.className = 'folder-icon';
    icon.innerText = '📁';
    
    const nameText = document.createElement('span');
    nameText.className = 'folder-name-text';
    nameText.innerText = folder.name;
    
    titleContainer.appendChild(arrow);
    titleContainer.appendChild(icon);
    titleContainer.appendChild(nameText);
    headerEl.appendChild(titleContainer);

    // Folder Actions (right side)
    const actionsEl = document.createElement('div');
    actionsEl.className = 'folder-actions';
    
    // 1. Add canvas inside folder button
    const addCanvasBtn = document.createElement('button');
    addCanvasBtn.className = 'action-icon';
    addCanvasBtn.title = currentLang === 'zh' ? '创建画布' : 'Create Canvas';
    addCanvasBtn.innerText = '＋';
    addCanvasBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = prompt(translations[currentLang].canvasPrompt);
      if (!name || name.trim() === '') return;
      
      const newCanvasId = 'canvas_' + Date.now();
      folder.canvases.push({
        id: newCanvasId,
        name: name.trim()
      });
      
      // Save empty board for new canvas
      safeLocalStorageSet('mindchat_board_' + newCanvasId, JSON.stringify([]), { critical: true });
      safeLocalStorageSet('mindchat_annotations_' + newCanvasId, JSON.stringify([]), { critical: true });
      safeLocalStorageSet('mindchat_knowledge_edges_' + newCanvasId, JSON.stringify([]), { critical: true });
      
      // Automatically expand folder if collapsed
      collapsedFolderIds = collapsedFolderIds.filter(id => id !== folder.id);
      
      saveLibrary();
      loadCanvas(newCanvasId);
    });
    
    // 2. Rename folder button
    const renameFolderBtn = document.createElement('button');
    renameFolderBtn.className = 'action-icon';
    renameFolderBtn.title = currentLang === 'zh' ? '重命名文件夹' : 'Rename Folder';
    renameFolderBtn.innerText = '✎';
    renameFolderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const newName = prompt(translations[currentLang].folderRenamePrompt, folder.name);
      if (!newName || newName.trim() === '' || newName.trim() === folder.name) return;
      
      folder.name = newName.trim();
      saveLibrary();
      renderExplorerTree();
    });
    
    // 3. Delete folder button
    const deleteFolderBtn = document.createElement('button');
    deleteFolderBtn.className = 'action-icon delete';
    deleteFolderBtn.title = currentLang === 'zh' ? '删除文件夹及所有画布' : 'Delete Folder';
    deleteFolderBtn.innerText = '🗑';
    deleteFolderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(translations[currentLang].folderDeleteConfirm.replace('{name}', folder.name))) {
        // Remove canvas node localstorage items
        folder.canvases.forEach(c => {
          removeStoredDataKey('mindchat_board_' + c.id);
          removeStoredDataKey('mindchat_annotations_' + c.id);
          removeStoredDataKey('mindchat_knowledge_edges_' + c.id);
        });
        
        library = library.filter(f => f.id !== folder.id);
        
        // If active canvas was inside deleted folder, switch canvas
        const hasActiveCanvas = folder.canvases.some(c => c.id === activeCanvasId);
        if (hasActiveCanvas) {
          const firstCanvas = getFirstCanvas();
          activeCanvasId = firstCanvas ? firstCanvas.id : null;
        }
        
        saveLibrary();
        loadLibrary();
      }
    });
    
    actionsEl.appendChild(addCanvasBtn);
    actionsEl.appendChild(renameFolderBtn);
    actionsEl.appendChild(deleteFolderBtn);
    headerEl.appendChild(actionsEl);
    folderEl.appendChild(headerEl);

    // Toggle collapse on folder header click (except action buttons)
    headerEl.addEventListener('click', (e) => {
      if (e.target.closest('.folder-actions')) return;
      
      if (isCollapsed) {
        collapsedFolderIds = collapsedFolderIds.filter(id => id !== folder.id);
      } else {
        collapsedFolderIds.push(folder.id);
      }
      saveLibrary();
      renderExplorerTree();
    });
    
    // Canvases Container list
    const canvasesEl = document.createElement('div');
    canvasesEl.className = 'folder-canvases';
    
    folder.canvases.forEach(canvas => {
      const isCanvasActive = canvas.id === activeCanvasId;
      
      const canvasNode = document.createElement('div');
      canvasNode.className = `canvas-node${isCanvasActive ? ' active' : ''}`;
      
      // Title container
      const cTitle = document.createElement('div');
      cTitle.className = 'canvas-title-container';
      
      const cIcon = document.createElement('span');
      cIcon.className = 'canvas-icon';
      cIcon.innerText = '📄';
      
      const cName = document.createElement('span');
      cName.className = 'canvas-name-text';
      cName.innerText = canvas.name;
      
      cTitle.appendChild(cIcon);
      cTitle.appendChild(cName);
      canvasNode.appendChild(cTitle);
      
      // Canvas Actions
      const cActions = document.createElement('div');
      cActions.className = 'canvas-actions';
      
      // Rename canvas button
      const renameCanvasBtn = document.createElement('button');
      renameCanvasBtn.className = 'action-icon';
      renameCanvasBtn.title = currentLang === 'zh' ? '重命名画布' : 'Rename Canvas';
      renameCanvasBtn.innerText = '✎';
      renameCanvasBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const newName = prompt(translations[currentLang].canvasRenamePrompt, canvas.name);
        if (!newName || newName.trim() === '' || newName.trim() === canvas.name) return;
        
        canvas.name = newName.trim();
        saveLibrary();
        renderExplorerTree();
      });
      
      // Delete canvas button
      const deleteCanvasBtn = document.createElement('button');
      deleteCanvasBtn.className = 'action-icon delete';
      deleteCanvasBtn.title = currentLang === 'zh' ? '删除画布' : 'Delete Canvas';
      deleteCanvasBtn.innerText = '🗑';
      deleteCanvasBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(translations[currentLang].canvasDeleteConfirm.replace('{name}', canvas.name))) {
          removeStoredDataKey('mindchat_board_' + canvas.id);
          removeStoredDataKey('mindchat_annotations_' + canvas.id);
          removeStoredDataKey('mindchat_knowledge_edges_' + canvas.id);
          folder.canvases = folder.canvases.filter(c => c.id !== canvas.id);
          
          if (canvas.id === activeCanvasId) {
            const firstCanvas = getFirstCanvas();
            activeCanvasId = firstCanvas ? firstCanvas.id : null;
          }
          
          saveLibrary();
          loadLibrary();
        }
      });
      
      cActions.appendChild(renameCanvasBtn);
      cActions.appendChild(deleteCanvasBtn);
      canvasNode.appendChild(cActions);
      canvasesEl.appendChild(canvasNode);
      
      // Switch active canvas on click (except actions)
      canvasNode.addEventListener('click', (e) => {
        if (e.target.closest('.canvas-actions')) return;
        loadCanvas(canvas.id);
      });
    });
    
    folderEl.appendChild(canvasesEl);
    treeEl.appendChild(folderEl);
  });
}

// Card copy actions
let copyMenuEl = null;
let copyToastTimer = null;

function isDialogueNode(node) {
  return node.question !== undefined || node.role === 'dialogue';
}

function cardQuestionText(node) {
  if (isDialogueNode(node)) return (node.question || '').trim();
  return node.role === 'user' ? (node.content || '').trim() : '';
}

function cardAnswerText(node) {
  if (isDialogueNode(node)) return (node.content || '').trim();
  return node.role === 'assistant' || node.role === 'model' ? (node.content || '').trim() : '';
}

function cardCopyText(node, mode) {
  const question = cardQuestionText(node);
  const answer = cardAnswerText(node);

  if (mode === 'question') return question;
  if (mode === 'answer') return answer;

  const userLabel = currentLang === 'zh' ? '\u7528\u6237' : 'User';
  const aiLabel = currentLang === 'zh' ? 'AI \u56de\u7b54' : 'AI Reply';
  if (question && answer) return `${userLabel}:\n${question}\n\n${aiLabel}:\n${answer}`;
  return (answer || question || node.content || '').trim();
}

async function writeClipboardText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

function showCopyToast(message, anchorEl) {
  let toast = document.getElementById('copy-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'copy-toast';
    toast.className = 'copy-toast';
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  const rect = anchorEl ? anchorEl.getBoundingClientRect() : { left: window.innerWidth / 2, top: 24, width: 0 };
  toast.style.left = `${Math.min(window.innerWidth - 140, Math.max(12, rect.left + rect.width / 2 - 52))}px`;
  toast.style.top = `${Math.max(12, rect.top - 36)}px`;
  toast.classList.add('show');

  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 1200);
}

async function copyCardSelection(node, mode, anchorEl) {
  const text = cardCopyText(node, mode);
  if (!text) {
    showCopyToast(currentLang === 'zh' ? '\u6ca1\u6709\u53ef\u590d\u5236\u7684\u5185\u5bb9' : 'Nothing to copy', anchorEl);
    return;
  }

  try {
    await writeClipboardText(text);
    const labels = {
      question: currentLang === 'zh' ? '\u5df2\u590d\u5236\u95ee\u9898' : 'Question copied',
      answer: currentLang === 'zh' ? '\u5df2\u590d\u5236\u56de\u7b54' : 'Answer copied',
      all: currentLang === 'zh' ? '\u5df2\u590d\u5236\u5168\u90e8' : 'All copied'
    };
    showCopyToast(labels[mode] || labels.answer, anchorEl);
  } catch (err) {
    showCopyToast(currentLang === 'zh' ? '\u590d\u5236\u5931\u8d25' : 'Copy failed', anchorEl);
  }
}

function hideCopyMenu() {
  if (copyMenuEl) copyMenuEl.classList.add('hidden');
}

function ensureCopyMenu() {
  if (copyMenuEl) return copyMenuEl;

  copyMenuEl = document.createElement('div');
  copyMenuEl.id = 'card-copy-menu';
  copyMenuEl.className = 'copy-menu hidden';
  document.body.appendChild(copyMenuEl);

  copyMenuEl.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.addEventListener('pointerdown', (e) => {
    if (!copyMenuEl || copyMenuEl.classList.contains('hidden')) return;
    if (copyMenuEl.contains(e.target) || e.target.closest('.copy-btn')) return;
    hideCopyMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideCopyMenu();
  });

  return copyMenuEl;
}

function showCopyMenu(anchorEl, node) {
  const menu = ensureCopyMenu();
  const options = [
    { mode: 'question', label: currentLang === 'zh' ? '\u590d\u5236\u95ee\u9898' : 'Copy question' },
    { mode: 'answer', label: currentLang === 'zh' ? '\u590d\u5236\u56de\u7b54' : 'Copy answer' },
    { mode: 'all', label: currentLang === 'zh' ? '\u5168\u90e8\u590d\u5236' : 'Copy all' }
  ];

  menu.innerHTML = '';
  options.forEach(option => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = option.label;
    btn.disabled = !cardCopyText(node, option.mode);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideCopyMenu();
      copyCardSelection(node, option.mode, anchorEl);
    });
    menu.appendChild(btn);
  });

  const rect = anchorEl.getBoundingClientRect();
  const menuWidth = 148;
  menu.style.left = `${Math.min(window.innerWidth - menuWidth - 12, Math.max(12, rect.right - menuWidth))}px`;
  menu.style.top = `${Math.min(window.innerHeight - 132, Math.max(12, rect.bottom + 8))}px`;
  menu.classList.remove('hidden');
}

function bindCardCopyButton(button, node) {
  let longPressTimer = null;
  let longPressed = false;
  const longPressDelay = 430;

  const cancelLongPress = () => {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  };

  button.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    longPressed = false;
    cancelLongPress();
    longPressTimer = setTimeout(() => {
      longPressed = true;
      showCopyMenu(button, node);
    }, longPressDelay);
  });

  button.addEventListener('pointerup', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cancelLongPress();
    if (!longPressed) copyCardSelection(node, 'answer', button);
  });

  button.addEventListener('pointerleave', cancelLongPress);
  button.addEventListener('pointercancel', cancelLongPress);
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  button.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    cancelLongPress();
    showCopyMenu(button, node);
  });
  button.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      copyCardSelection(node, 'answer', button);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      showCopyMenu(button, node);
    }
  });
}

// Global Preview Popover implementation
let previewPopoverEl = null;
let showPopoverTimeout = null;
let hidePopoverTimeout = null;

function initPreviewPopover() {
  if (document.getElementById('global-preview-popover')) return;
  previewPopoverEl = document.createElement('div');
  previewPopoverEl.id = 'global-preview-popover';
  previewPopoverEl.className = 'preview-popover hidden';
  
  const content = document.createElement('div');
  content.className = 'popover-content';
  previewPopoverEl.appendChild(content);
  
  document.body.appendChild(previewPopoverEl);
  
  // Keep popover visible on mouseenter, hide on mouseleave
  previewPopoverEl.addEventListener('mouseenter', () => {
    if (hidePopoverTimeout) {
      clearTimeout(hidePopoverTimeout);
      hidePopoverTimeout = null;
    }
  });
  
  previewPopoverEl.addEventListener('mouseleave', () => {
    hidePopoverTimeout = setTimeout(hidePopover, 200);
  });
}

function showPopover(contentHtml, anchorEl) {
  if (!previewPopoverEl) return;
  
  const contentDiv = previewPopoverEl.querySelector('.popover-content');
  if (contentDiv) {
    contentDiv.innerHTML = contentHtml;
  }
  
  previewPopoverEl.classList.remove('hidden');
  
  const rect = anchorEl.getBoundingClientRect();
  const popoverWidth = 450;
  const popoverHeight = 300;
  
  let left = rect.right + 10;
  let top = rect.top;
  
  if (left + popoverWidth > window.innerWidth) {
    left = rect.left - popoverWidth - 10;
  }
  
  if (top + popoverHeight > window.innerHeight) {
    top = window.innerHeight - popoverHeight - 20;
  }
  
  if (top < 10) top = 10;
  if (left < 10) left = 10;
  
  previewPopoverEl.style.left = `${left}px`;
  previewPopoverEl.style.top = `${top}px`;
  previewPopoverEl.style.width = `${popoverWidth}px`;
  previewPopoverEl.style.height = `${popoverHeight}px`;
}

function hidePopover() {
  if (previewPopoverEl) {
    previewPopoverEl.classList.add('hidden');
  }
}

function bindPreviewHover(btnEl, textGetter, delay = 600) {
  btnEl.addEventListener('mouseenter', () => {
    if (hidePopoverTimeout) {
      clearTimeout(hidePopoverTimeout);
      hidePopoverTimeout = null;
    }

    showPopoverTimeout = setTimeout(() => {
      const text = textGetter();
      const html = renderMarkdown(text);
      showPopover(html, btnEl);
    }, delay); // Trigger preview after hovering for `delay` ms
  });
  
  btnEl.addEventListener('mouseleave', () => {
    if (showPopoverTimeout) {
      clearTimeout(showPopoverTimeout);
      showPopoverTimeout = null;
    }
    hidePopoverTimeout = setTimeout(hidePopover, 200);
  });
}
