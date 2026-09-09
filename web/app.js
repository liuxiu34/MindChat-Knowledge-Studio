const workspace = new MindWorkspace.WorkspaceStore();
let model = workspace.currentModel();
const demoCards = [
    { id: 'demo-1', kind: 'dialogue', title: '第一轮对话', question: '什么是模型路由？', content: '按任务选择不同模型。', x: 80, y: 150 },
    { id: 'demo-2', kind: 'dialogue', title: '第二轮对话', question: 'Luna 适合什么？', content: '适合轻量提取与分类。', x: 430, y: 150 },
    { id: 'demo-3', kind: 'knowledge', title: '模型选型知识卡', category: '对比选型', summary_a: 'Terra 更适合日常开发。', x: 780, y: 330 }
];
if (!model.cards.length) { demoCards.forEach(card => model.addCard(card)); model.addConversationEdge('demo-1', 'demo-2'); model.setSemanticEdges([{ source: 'demo-1', target: 'demo-2', relation: '延伸', reason: '对话顺序重合' }, { source: 'demo-1', target: 'demo-3', relation: '依赖', reason: '先理解路由再选模型' }]); workspace.saveModel(model); }

const cardsEl = document.getElementById('cards');
const edgesEl = document.getElementById('edges');
const viewport = document.getElementById('viewport');
const canvasSelect = document.getElementById('canvasSelect');
const searchInput = document.getElementById('searchInput');

function refreshCanvasSelect() { canvasSelect.innerHTML = workspace.state.canvases.map(canvas => `<option value="${canvas.id}">${escapeHtml(canvas.name)}</option>`).join(''); canvasSelect.value = workspace.state.activeCanvasId; }

function render() {
  cardsEl.innerHTML = '';
  edgesEl.innerHTML = '<defs><marker id="arrowBlue" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 z" fill="#60a5fa"/></marker><marker id="arrowPurple" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 z" fill="#a78bfa"/></marker></defs>';
  const cards = searchInput.value ? workspace.search(searchInput.value) : model.cards;
  cards.forEach(card => {
    const el = document.createElement('article');
    el.className = 'card'; el.dataset.id = card.id; el.style.left = `${card.x || 0}px`; el.style.top = `${card.y || 0}px`;
    el.innerHTML = `<h3>${escapeHtml(card.title || card.id)}</h3><p>${escapeHtml(card.question || card.summary_q || card.content || card.summary_a || '')}</p>`;
    let start = null;
    el.addEventListener('pointerdown', event => { start = { x: event.clientX, y: event.clientY, left: card.x || 0, top: card.y || 0 }; el.setPointerCapture(event.pointerId); });
    el.addEventListener('pointermove', event => { if (!start) return; card.x = start.left + event.clientX - start.x; card.y = start.top + event.clientY - start.y; el.style.left = `${card.x}px`; el.style.top = `${card.y}px`; workspace.saveModel(model); renderEdges(); });
    el.addEventListener('pointerup', () => { start = null; });
    cardsEl.appendChild(el);
  });
  renderEdges();
}

function renderEdges() {
  edgesEl.querySelectorAll('.dynamic-edge').forEach(el => el.remove());
  model.getVisibleEdges({ conversation: document.getElementById('showConversation').checked, semantic: document.getElementById('showSemantic').checked }).forEach(edge => {
    const source = model.cards.find(card => card.id === edge.source); const target = model.cards.find(card => card.id === edge.target); if (!source || !target) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); line.classList.add('dynamic-edge', edge.type === 'conversation' ? 'edge-conversation' : 'edge-semantic');
    line.setAttribute('x1', (source.x || 0) + 270); line.setAttribute('y1', (source.y || 0) + 65); line.setAttribute('x2', target.x || 0); line.setAttribute('y2', (target.y || 0) + 65); edgesEl.appendChild(line);
    if (edge.type === 'semantic') { const label = document.createElementNS('http://www.w3.org/2000/svg', 'text'); label.classList.add('dynamic-edge', 'edge-label'); label.setAttribute('x', ((source.x || 0) + (target.x || 0) + 270) / 2); label.setAttribute('y', ((source.y || 0) + (target.y || 0)) / 2 + 55); label.textContent = edge.relation; edgesEl.appendChild(label); }
  });
}

function escapeHtml(value) { const div = document.createElement('div'); div.textContent = value == null ? '' : String(value); return div.innerHTML; }
document.getElementById('showConversation').addEventListener('change', renderEdges);
document.getElementById('showSemantic').addEventListener('change', renderEdges);
canvasSelect.addEventListener('change', event => { workspace.openCanvas(event.target.value); model = workspace.currentModel(); render(); });
document.getElementById('newCanvas').addEventListener('click', () => { const name = prompt('新画布名称：', '新画布'); if (name) { workspace.createCanvas(name); model = workspace.currentModel(); refreshCanvasSelect(); render(); } });
searchInput.addEventListener('input', render);
refreshCanvasSelect();
render();
