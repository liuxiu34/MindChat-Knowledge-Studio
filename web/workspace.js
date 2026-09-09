/* 新项目工作区：多画布、搜索、持久化和备份恢复。 */
(function (root) {
  class WorkspaceStore {
    constructor(storage, key = 'mindchat-knowledge-studio-workspace-v1') {
      this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
      this.key = key;
      this.state = this._load();
    }

    _load() {
      try {
        const parsed = this.storage && JSON.parse(this.storage.getItem(this.key) || 'null');
        if (parsed && Array.isArray(parsed.canvases) && parsed.canvases.length) return parsed;
      } catch (error) { /* 损坏数据回退到默认工作区 */ }
      const canvas = { id: `canvas-${Date.now()}`, name: '默认画布', cards: [], conversationEdges: [], semanticEdges: [], groups: [], annotations: [] };
      return { version: 1, canvases: [canvas], activeCanvasId: canvas.id };
    }

    save() {
      if (this.storage) this.storage.setItem(this.key, JSON.stringify(this.state));
    }

    currentCanvas() { return this.state.canvases.find(canvas => canvas.id === this.state.activeCanvasId) || this.state.canvases[0]; }

    currentModel() { return new root.MindCanvasModel.BoardModel(this.currentCanvas()); }

    saveModel(model) {
      const canvas = this.currentCanvas();
      if (!canvas) return;
      Object.assign(canvas, model.toJSON());
      this.save();
    }

    createCanvas(name) {
      const canvas = { id: `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: name || '新画布', cards: [], conversationEdges: [], semanticEdges: [], groups: [], annotations: [] };
      this.state.canvases.push(canvas); this.state.activeCanvasId = canvas.id; this.save(); return canvas;
    }

    openCanvas(id) { if (!this.state.canvases.some(canvas => canvas.id === id)) throw new Error('画布不存在'); this.state.activeCanvasId = id; this.save(); return this.currentCanvas(); }

    renameCanvas(id, name) { const canvas = this.state.canvases.find(item => item.id === id); if (!canvas) throw new Error('画布不存在'); canvas.name = String(name || '').trim() || canvas.name; this.save(); return canvas; }

    deleteCanvas(id) { if (this.state.canvases.length === 1) throw new Error('至少保留一个画布'); this.state.canvases = this.state.canvases.filter(canvas => canvas.id !== id); if (this.state.activeCanvasId === id) this.state.activeCanvasId = this.state.canvases[0].id; this.save(); }

    search(query) {
      const needle = String(query || '').trim().toLowerCase();
      if (!needle) return this.currentCanvas().cards;
      return this.currentCanvas().cards.filter(card => JSON.stringify(card).toLowerCase().includes(needle));
    }

    exportBackup() { return JSON.parse(JSON.stringify(this.state)); }

    importBackup(data) {
      if (!data || data.version !== 1 || !Array.isArray(data.canvases) || !data.canvases.length) throw new Error('无效的工作区备份');
      this.state = JSON.parse(JSON.stringify(data)); this.save(); return this.state;
    }
  }

  root.MindWorkspace = { WorkspaceStore };
})(typeof globalThis !== 'undefined' ? globalThis : window);
