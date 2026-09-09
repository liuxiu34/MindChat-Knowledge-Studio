/* 双层画布的纯数据模型：对话边与知识边始终独立保存。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MindCanvasModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const RELATIONS = new Set(['延伸', '相似', '对比', '依赖', '补充']);

  function pairKey(source, target) {
    return [String(source), String(target)].sort().join('::');
  }

  class BoardModel {
    constructor(initial = {}) {
      this.cards = Array.isArray(initial.cards) ? initial.cards.map(card => ({ ...card })) : [];
      this.conversationEdges = Array.isArray(initial.conversationEdges)
        ? initial.conversationEdges.map(edge => ({ ...edge })) : [];
      this.semanticEdges = Array.isArray(initial.semanticEdges)
        ? initial.semanticEdges.map(edge => ({ ...edge })) : [];
    }

    addCard(card) {
      if (!card || !card.id) throw new Error('卡片必须包含 id');
      if (this.cards.some(item => item.id === card.id)) throw new Error(`卡片 id 重复：${card.id}`);
      this.cards.push({ kind: 'dialogue', ...card });
      return card;
    }

    addConversationEdge(source, target) {
      if (!this.cards.some(card => card.id === source) || !this.cards.some(card => card.id === target)) {
        throw new Error('对话边引用了不存在的卡片');
      }
      if (source === target) throw new Error('对话边不能连接自身');
      const edge = { source, target, type: 'conversation' };
      if (!this.conversationEdges.some(item => pairKey(item.source, item.target) === pairKey(source, target))) {
        this.conversationEdges.push(edge);
      }
      return edge;
    }

    setSemanticEdges(edges) {
      this.semanticEdges = (Array.isArray(edges) ? edges : []).filter(edge => {
        return edge && edge.source !== edge.target
          && this.cards.some(card => card.id === edge.source)
          && this.cards.some(card => card.id === edge.target);
      }).map(edge => ({
        source: edge.source,
        target: edge.target,
        relation: RELATIONS.has(edge.relation) ? edge.relation : '补充',
        reason: String(edge.reason || ''),
        confidence: Number.isFinite(Number(edge.confidence)) ? Number(edge.confidence) : null,
        type: 'semantic'
      }));
      return this.semanticEdges;
    }

    getVisibleEdges({ conversation = true, semantic = true } = {}) {
      const visible = [];
      const conversationPairs = new Set();
      if (conversation) {
        this.conversationEdges.forEach(edge => {
          conversationPairs.add(pairKey(edge.source, edge.target));
          visible.push({ ...edge, type: 'conversation', overlap: false });
        });
      }
      if (semantic) {
        this.semanticEdges.forEach(edge => {
          const overlap = conversationPairs.has(pairKey(edge.source, edge.target));
          if (!overlap || !conversation) visible.push({ ...edge, type: 'semantic', overlap });
        });
      }
      return visible;
    }

    toJSON() {
      return {
        version: 1,
        cards: this.cards.map(card => ({ ...card })),
        conversationEdges: this.conversationEdges.map(edge => ({ ...edge })),
        semanticEdges: this.semanticEdges.map(edge => ({ ...edge }))
      };
    }
  }

  return { BoardModel, pairKey, RELATIONS };
});
