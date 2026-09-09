const assert = require('assert');
const { BoardModel } = require('../web/board-model.js');

const board = new BoardModel();
['a', 'b', 'c'].forEach(id => board.addCard({ id, title: id }));
board.addConversationEdge('a', 'b');
board.addConversationEdge('b', 'c');
board.setSemanticEdges([
  { source: 'a', target: 'b', relation: '延伸', reason: '顺序重合' },
  { source: 'a', target: 'c', relation: '依赖', reason: '跨卡片语义关系' }
]);

assert.strictEqual(board.conversationEdges.length, 2);
assert.strictEqual(board.semanticEdges.length, 2);
assert.strictEqual(board.getVisibleEdges().length, 3);
assert.strictEqual(board.getVisibleEdges().filter(edge => edge.type === 'semantic').length, 1);
assert.strictEqual(board.getVisibleEdges({ conversation: false }).length, 2);
assert.strictEqual(board.toJSON().semanticEdges[0].relation, '延伸');
console.log('board model smoke: 2 conversation edges + 2 semantic edges -> 3 visible edges');
