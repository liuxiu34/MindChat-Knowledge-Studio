(function () {
  window.MindChatModules = window.MindChatModules || {};

  window.MindChatModules.createKnowledgeExtension = function createKnowledgeExtension(context) {
    const getNodes = context.getNodes;
    const getEdges = context.getEdges;

    function pairKey(source, target) {
      return [String(source), String(target)].sort().join('::');
    }

    function isConversationEdge(sourceId, targetId) {
      return getNodes().some(node =>
        (node.id === targetId && node.parentId === sourceId)
        || (node.id === sourceId && node.parentId === targetId));
    }

    function visibleEdges() {
      return getEdges().filter(edge => edge && !isConversationEdge(edge.source, edge.target));
    }

    function relationColor(relation) {
      return ({
        '延伸': '#60a5fa',
        '相似': '#a78bfa',
        '对比': '#f59e0b',
        '依赖': '#f87171',
        '补充': '#34d399'
      })[relation] || '#94a3b8';
    }

    function toKnowledgeCard(node, index) {
      const knowledge = node.knowledge || {};
      const title = knowledge.title || node.question || `对话 ${index + 1}`;
      return {
        id: node.id,
        title,
        category: knowledge.category || '其他',
        summary_q: knowledge.summary_q || node.question || node.content || title,
        summary_a: knowledge.summary_a || (node.question !== undefined ? node.content : node.content || ''),
        keywords: Array.isArray(knowledge.keywords) ? knowledge.keywords : [],
        source: knowledge.source || 'qibu'
      };
    }

    function mergeGraphEdges(edges) {
      const seen = new Set();
      return (Array.isArray(edges) ? edges : []).filter(edge => {
        if (!edge || !edge.source || !edge.target || edge.source === edge.target) return false;
        const key = pairKey(edge.source, edge.target);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).map(edge => ({
        source: String(edge.source),
        target: String(edge.target),
        relation: String(edge.relation || edge.label || '补充'),
        reason: String(edge.reason || ''),
        confidence: edge.confidence == null ? null : Number(edge.confidence)
      }));
    }

    return { pairKey, isConversationEdge, visibleEdges, relationColor, toKnowledgeCard, mergeGraphEdges };
  };
})();
