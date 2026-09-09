(function () {
  window.MindChatModules = window.MindChatModules || {};

  window.MindChatModules.createChatModule = function createChatModule(ctx) {
    let chatNav = [];
    const chatForkMode = {};
    const chatForkSel = {};
    const chatBranchOpen = {};
    let chatComposerText = '';

    function t(zh, en) {
      return ctx.currentLang() === 'zh' ? zh : en;
    }

    function nodes() {
      return ctx.nodes();
    }

    function setChatMode(on) {
      const next = !!on;
      ctx.setChatModeValue(next);
      if (next) ctx.setCommentMode(false);
      if (next && ctx.treeMode()) {
        ctx.setTreeModeValue(false);
        document.body.classList.remove('tree-mode');
        const tb = document.getElementById('tree-mode-btn');
        if (tb) tb.classList.remove('active');
      }
      document.body.classList.toggle('chat-mode', next);
      const btn = document.getElementById('chat-mode-btn');
      if (btn) btn.classList.toggle('active', next);
      try { localStorage.setItem('mindchat_chat_mode', next ? '1' : '0'); } catch (e) {}
      if (next) {
        chatNav = [];
        renderChatView();
      }
    }

    function chatContinuation(node) {
      return nodes().find(n => n.parentId === node.id && !n.isFollowUp) || null;
    }

    function chatBranches(node) {
      return nodes().filter(n => n.parentId === node.id && n.isFollowUp);
    }

    function chatThread(startNode) {
      const thread = [];
      const seen = new Set();
      let cur = startNode;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        thread.push(cur);
        cur = chatContinuation(cur);
      }
      return thread;
    }

    function chatThreadTail(startNode) {
      const thread = chatThread(startNode);
      return thread.length > 0 ? thread[thread.length - 1] : startNode;
    }

    function chatBranchLabel(branchNode) {
      const raw = (branchNode.question || branchNode.content || '').replace(/\s+/g, ' ').trim();
      if (!raw) return t('\u8ffd\u95ee', 'Follow-up');
      return raw.length > 18 ? raw.slice(0, 18) + '...' : raw;
    }

    function getNewConversationPosition() {
      const cardWidth = ctx.getCardWidth();
      const allNodes = nodes();
      if (allNodes.length === 0) {
        return {
          x: 25000 - cardWidth / 2,
          y: 25000 - 120,
          z: 0
        };
      }

      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      allNodes.forEach(node => {
        const width = ctx.getNodeRenderedWidth(node);
        const height = ctx.getNodeRenderedHeight(node);
        right = Math.max(right, node.x + width);
        top = Math.min(top, node.y);
        bottom = Math.max(bottom, node.y + height);
      });

      const gap = 180;
      let x = right + gap;
      let y = top;
      const newHeight = 210;
      const overlaps = () => allNodes.some(node => {
        const width = ctx.getNodeRenderedWidth(node);
        const height = ctx.getNodeRenderedHeight(node);
        return !(x > node.x + width + 28 || x + cardWidth < node.x - 28 || y > node.y + height + 28 || y + newHeight < node.y - 28);
      });

      let attempts = 0;
      while (overlaps() && attempts < 18) {
        y += 260;
        if (y > bottom + 260) {
          x += cardWidth + gap;
          y = top;
        }
        attempts += 1;
      }

      return { x, y, z: 0 };
    }

    function createChatDialogueNode(question, parentId = null) {
      const allNodes = nodes();
      const parent = parentId ? allNodes.find(n => n.id === parentId) : null;
      const cardWidth = ctx.getCardWidth();
      const id = `node_${Date.now()}_chat`;
      const position = parent
        ? {
            x: parent.x + cardWidth + 120,
            y: parent.y,
            z: parent.z || 0
          }
        : getNewConversationPosition();

      const node = {
        id,
        parentId,
        role: 'dialogue',
        question: question.trim(),
        content: '',
        x: position.x,
        y: position.y,
        z: position.z || 0,
        isLoading: true,
        isFollowUp: false,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      allNodes.push(node);
      ctx.rememberActiveNode(id);
      ctx.setSelectedNodeIds([id]);
      ctx.saveBoard(parentId ? 'chat continued conversation' : 'chat new conversation');
      ctx.renderBoard();
      ctx.triggerAI(id, id);
      return node;
    }

    function getChatComposerParent() {
      if (chatNav.length === 0) return null;
      const start = nodes().find(n => n.id === chatNav[chatNav.length - 1]);
      if (!start) return null;
      return chatThreadTail(start);
    }

    function submitChatComposer(text) {
      const question = String(text || '').trim();
      if (!question) return;
      chatComposerText = '';
      const parent = getChatComposerParent();
      const node = createChatDialogueNode(question, parent ? parent.id : null);
      if (!parent) chatNav = [node.id];
      renderChatView();
    }

    function focusChatComposer() {
      requestAnimationFrame(() => {
        const input = document.getElementById('chat-composer-input');
        if (input) input.focus();
      });
    }

    function startNewChatConversation() {
      chatNav = [];
      chatComposerText = '';
      renderChatView();
      focusChatComposer();
    }

    function appendChatMessage(container, role, text, node) {
      const row = document.createElement('div');
      row.className = `chat-msg chat-msg-${role}`;

      const bubble = document.createElement('div');
      bubble.className = 'chat-bubble';

      const meta = document.createElement('div');
      meta.className = 'chat-msg-meta';
      const icon = role === 'user' ? '\ud83d\udc64' : '\ud83e\udd16';
      const translations = ctx.translations();
      const label = role === 'user' ? translations[ctx.currentLang()].userRole : translations[ctx.currentLang()].aiRole;
      meta.innerHTML = `<span class="role-icon">${icon}</span> ${label}` +
        (node && node.timestamp ? ` \u00b7 ${node.timestamp}` : '');
      bubble.appendChild(meta);

      const content = document.createElement('div');
      content.className = 'chat-msg-content';
      const body = text && text.trim() ? text : (node && node.isLoading ? '...' : '');
      content.innerHTML = ctx.renderMarkdown(body);
      bubble.appendChild(content);

      if (node && node.image && role === 'user') {
        const img = document.createElement('img');
        img.src = node.image;
        img.className = 'chat-msg-image';
        bubble.appendChild(img);
      }

      if (node) {
        const actions = document.createElement('div');
        actions.className = 'chat-msg-actions';

        const locateBtn = document.createElement('button');
        locateBtn.className = 'chat-action-btn';
        locateBtn.textContent = ctx.translations()[ctx.currentLang()].chatLocate;
        locateBtn.addEventListener('click', () => ctx.locateOnCanvas(node.id));
        actions.appendChild(locateBtn);

        if (role === 'assistant') {
          const followBtn = document.createElement('button');
          followBtn.className = 'chat-action-btn chat-action-followup';
          followBtn.textContent = ctx.translations()[ctx.currentLang()].chatFollowUp;
          followBtn.addEventListener('click', () => ctx.followUpFromChat(node.id));
          actions.appendChild(followBtn);
        }

        bubble.appendChild(actions);
      }

      row.appendChild(bubble);
      container.appendChild(row);
    }

    function renderChatView() {
      const inner = document.getElementById('chat-view-inner');
      if (!inner) return;
      inner.innerHTML = '';
      renderChatTopbar(inner);

      const allNodes = nodes();
      const roots = allNodes.filter(n => !n.parentId || !allNodes.find(p => p.id === n.parentId));
      if (roots.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'chat-empty';
        empty.textContent = t('\u5f53\u524d\u753b\u5e03\u6682\u65e0\u6d88\u606f', 'No messages on this canvas');
        inner.appendChild(empty);
        renderChatComposer(inner);
        return;
      }

      renderChatBreadcrumb(inner);

      if (chatNav.length > 0) {
        const startNode = allNodes.find(n => n.id === chatNav[chatNav.length - 1]);
        if (!startNode) {
          chatNav = [];
          renderChatView();
          return;
        }
        renderChatThread(inner, startNode, true);
      } else {
        roots.forEach(root => renderChatThread(inner, root, false));
      }
      renderChatComposer(inner);
    }

    function renderChatTopbar(container) {
      const bar = document.createElement('div');
      bar.className = 'chat-topbar';

      const title = document.createElement('div');
      title.className = 'chat-topbar-title';
      title.textContent = t('\u804a\u5929', 'Chat');

      const newBtn = document.createElement('button');
      newBtn.className = 'chat-new-btn';
      newBtn.type = 'button';
      newBtn.textContent = t('+ \u65b0\u5bf9\u8bdd', '+ New chat');
      newBtn.addEventListener('click', startNewChatConversation);

      bar.appendChild(title);
      bar.appendChild(newBtn);
      container.appendChild(bar);
    }

    function renderChatComposer(container) {
      const parent = getChatComposerParent();
      const wrap = document.createElement('div');
      wrap.className = 'chat-composer';

      const input = document.createElement('textarea');
      input.id = 'chat-composer-input';
      input.className = 'chat-composer-input';
      input.rows = 1;
      input.value = chatComposerText;
      input.placeholder = parent
        ? t('\u7ee7\u7eed\u8fd9\u6bb5\u5bf9\u8bdd...', 'Continue this chat...')
        : t('\u5f00\u59cb\u4e00\u6bb5\u65b0\u7684\u5bf9\u8bdd...', 'Start a new chat...');
      input.addEventListener('input', () => {
        chatComposerText = input.value;
        input.style.height = 'auto';
        input.style.height = `${Math.min(160, input.scrollHeight)}px`;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submitChatComposer(input.value);
        }
      });

      const send = document.createElement('button');
      send.className = 'chat-send-btn';
      send.type = 'button';
      send.textContent = '\u27a4';
      send.title = t('\u53d1\u9001', 'Send');
      send.addEventListener('click', () => submitChatComposer(input.value));

      wrap.appendChild(input);
      wrap.appendChild(send);
      container.appendChild(wrap);

      requestAnimationFrame(() => {
        input.style.height = 'auto';
        input.style.height = `${Math.min(160, input.scrollHeight)}px`;
      });
    }

    function renderChatBreadcrumb(container) {
      const bar = document.createElement('div');
      bar.className = 'chat-breadcrumb';

      const home = document.createElement('a');
      home.textContent = t('\u4e3b\u7ebf\u5bf9\u8bdd', 'Main thread');
      home.addEventListener('click', () => {
        chatNav = [];
        renderChatView();
      });
      bar.appendChild(home);

      chatNav.forEach((id, i) => {
        const node = nodes().find(n => n.id === id);
        const sep = document.createElement('span');
        sep.className = 'chat-crumb-sep';
        sep.textContent = '\u203a';
        bar.appendChild(sep);
        const a = document.createElement('a');
        a.textContent = node ? chatBranchLabel(node) : '...';
        const depth = i + 1;
        a.addEventListener('click', () => {
          chatNav = chatNav.slice(0, depth);
          renderChatView();
        });
        bar.appendChild(a);
      });

      container.appendChild(bar);
    }

    function renderChatThread(container, startNode, insideBranch) {
      chatThread(startNode).forEach(node => {
        renderChatNode(container, node);
        const branches = chatBranches(node);
        if (branches.length > 0) {
          renderChatFork(container, node, branches, insideBranch);
        }
      });
    }

    function renderChatNode(container, node) {
      const isDialogue = node.question !== undefined || node.role === 'dialogue';
      if (isDialogue) {
        if (node.question && node.question.trim()) appendChatMessage(container, 'user', node.question, node);
        appendChatMessage(container, 'assistant', node.content, node);
      } else {
        appendChatMessage(container, node.role === 'user' ? 'user' : 'assistant', node.content, node);
      }
    }

    function renderChatFork(container, node, branches, insideBranch) {
      if (!insideBranch) {
        renderForkEnter(container, branches);
        return;
      }

      const mode = chatForkMode[node.id] || 'B';
      const wrap = document.createElement('div');
      wrap.className = 'chat-fork';

      const toggle = document.createElement('button');
      toggle.className = 'chat-fork-toggle';
      toggle.textContent = `\u21c6 ${mode}`;
      toggle.title = t('\u5207\u6362\u5206\u652f\u5448\u73b0: A \u5207\u6362\u5668 / B \u5c55\u5f00 / C \u8fdb\u5165', 'Switch branch view: A switcher / B expand / C enter');
      toggle.addEventListener('click', () => {
        chatForkMode[node.id] = { A: 'B', B: 'C', C: 'A' }[mode];
        renderChatView();
      });
      wrap.appendChild(toggle);

      if (mode === 'C') {
        renderForkEnter(wrap, branches);
      } else if (mode === 'A') {
        renderForkSwitcher(wrap, node, branches);
      } else {
        renderForkExpand(wrap, branches);
      }
      container.appendChild(wrap);
    }

    function renderForkEnter(container, branches) {
      const row = document.createElement('div');
      row.className = 'chat-enter-row';
      branches.forEach(b => {
        const chip = document.createElement('button');
        chip.className = 'chat-enter-chip';
        chip.textContent = `\u2192 ${chatBranchLabel(b)}`;
        chip.addEventListener('click', () => {
          chatNav.push(b.id);
          renderChatView();
        });
        row.appendChild(chip);
      });
      container.appendChild(row);
    }

    function renderForkSwitcher(container, node, branches) {
      const sel = Math.min(chatForkSel[node.id] || 0, branches.length - 1);
      chatForkSel[node.id] = sel;

      const bar = document.createElement('div');
      bar.className = 'chat-switcher';

      const prev = document.createElement('button');
      prev.textContent = '\u25c0';
      prev.addEventListener('click', () => {
        chatForkSel[node.id] = (sel - 1 + branches.length) % branches.length;
        renderChatView();
      });

      const label = document.createElement('span');
      label.className = 'chat-switcher-label';
      label.textContent = `${sel + 1}/${branches.length} \u00b7 ${chatBranchLabel(branches[sel])}`;

      const next = document.createElement('button');
      next.textContent = '\u25b6';
      next.addEventListener('click', () => {
        chatForkSel[node.id] = (sel + 1) % branches.length;
        renderChatView();
      });

      bar.appendChild(prev);
      bar.appendChild(label);
      bar.appendChild(next);
      container.appendChild(bar);

      const branchBox = document.createElement('div');
      branchBox.className = 'chat-branch';
      renderChatThread(branchBox, branches[sel], true);
      container.appendChild(branchBox);
    }

    function renderForkExpand(container, branches) {
      branches.forEach(b => {
        if (chatBranchOpen[b.id] === undefined) chatBranchOpen[b.id] = true;
        const block = document.createElement('div');
        block.className = 'chat-branch-block' + (chatBranchOpen[b.id] ? '' : ' collapsed');

        const head = document.createElement('div');
        head.className = 'chat-branch-head';
        head.innerHTML = `<span class="chat-caret">\u25be</span> ${chatBranchLabel(b)}`;
        head.addEventListener('click', () => {
          chatBranchOpen[b.id] = !chatBranchOpen[b.id];
          renderChatView();
        });
        block.appendChild(head);

        const body = document.createElement('div');
        body.className = 'chat-branch-body';
        renderChatThread(body, b, true);
        block.appendChild(body);

        container.appendChild(block);
      });
    }

    return {
      setChatMode,
      renderChatView,
      chatBranchLabel
    };
  };
})();
