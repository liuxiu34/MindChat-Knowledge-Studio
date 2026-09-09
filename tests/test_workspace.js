const assert = require('assert');
const { BoardModel } = require('../web/board-model.js');
const { WorkspaceStore } = (() => { global.MindCanvasModel = require('../web/board-model.js'); const fs = require('fs'); const vm = require('vm'); const code = fs.readFileSync(require('path').join(__dirname, '../web/workspace.js'), 'utf8'); vm.runInThisContext(code); return global.MindWorkspace; })();

const storage = { data: {}, getItem(key) { return this.data[key] || null; }, setItem(key, value) { this.data[key] = value; } };
const store = new WorkspaceStore(storage, 'test');
let model = store.currentModel();
model.addCard({ id: 'a', title: '模型路由' });
store.saveModel(model);
assert.strictEqual(store.search('路由').length, 1);
const second = store.createCanvas('第二画布');
assert.strictEqual(store.state.canvases.length, 2);
store.openCanvas(second.id);
assert.strictEqual(store.currentModel().cards.length, 0);
const backup = store.exportBackup();
store.deleteCanvas(second.id);
store.importBackup(backup);
assert.strictEqual(store.state.canvases.length, 2);
console.log('workspace smoke: create/search/switch/delete/backup restore passed');
