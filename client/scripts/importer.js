(function () {
  window.MindChatModules = window.MindChatModules || {};

  window.MindChatModules.createImporterModule = function createImporterModule() {
    function normalizeMessage(item) {
      const roleVal = item.role || item.sender || item.type || item.author || 'user';
      const contentVal = item.content || item.text || item.message || item.say || item.body
        || (Array.isArray(item.contents)
          ? item.contents.filter(part => part && part.type === 'text').map(part => part.content || '').join('\n')
          : '');
      const timeVal = item.timestamp || item.time || item.created_at || '';

      return {
        role: /assistant|model|bot|ai|gpt|claude/i.test(roleVal) ? 'assistant' : 'user',
        content: String(contentVal || ''),
        timestamp: timeVal || ''
      };
    }

    function parseJsonChatLog(rawText) {
      const parsed = JSON.parse(rawText);
      let messageList = null;

      if (Array.isArray(parsed)) {
        messageList = parsed;
      } else if (parsed && typeof parsed === 'object') {
        const arrayKey = Object.keys(parsed).find(key => Array.isArray(parsed[key]));
        if (arrayKey) messageList = parsed[arrayKey];
      }

      if (!Array.isArray(messageList)) {
        throw new Error('No message array found in JSON.');
      }

      return messageList
        .map(normalizeMessage)
        .filter(item => item.content && item.content.trim() !== '');
    }

    function parseTextChatLog(text) {
      const lines = String(text || '').split('\n');
      const messages = [];
      let currentMessage = null;
      let hasStarted = false;

      const userPattern = /^(user|me|human|visitor|client|person\s?\d*|you\s+asked|用户|我|访客|提问者)\s*(?:[:：]|$)/i;
      const assistantPattern = /^(assistant|ai|chatgpt|claude|gemini|gpt|model|deepseek|bot|助手|机器人|客服)\s*(?:response\s*)?(?:[:：]|$)/i;
      const timestampPattern = /^(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(\s+\d{1,2}:\d{2}(:\d{2})?)?|\d{1,2}:\d{2}(:\d{2})?)$/;

      lines.forEach(line => {
        const trimmedLine = line.trim();
        if (trimmedLine === '') return;

        const userMatch = trimmedLine.match(userPattern);
        const assistantMatch = trimmedLine.match(assistantPattern);

        if (userMatch) {
          hasStarted = true;
          if (currentMessage) messages.push(currentMessage);
          currentMessage = {
            role: 'user',
            content: trimmedLine.substring(userMatch[0].length).trim(),
            timestamp: '',
            expectsTimestamp: true
          };
          return;
        }

        if (assistantMatch) {
          hasStarted = true;
          if (currentMessage) messages.push(currentMessage);
          currentMessage = {
            role: 'assistant',
            content: trimmedLine.substring(assistantMatch[0].length).trim(),
            timestamp: '',
            expectsTimestamp: true
          };
          return;
        }

        if (!hasStarted || !currentMessage) return;

        if (currentMessage.expectsTimestamp) {
          currentMessage.expectsTimestamp = false;
          if (timestampPattern.test(trimmedLine)) {
            currentMessage.timestamp = trimmedLine;
            return;
          }
        }

        currentMessage.content += (currentMessage.content ? '\n' : '') + trimmedLine;
      });

      if (currentMessage) messages.push(currentMessage);

      if (messages.length > 0) {
        const lastMsg = messages[messages.length - 1];
        lastMsg.content = lastMsg.content
          .replace(/Powered by Claude Exporter\s*\(https:\/\/www\.ai-chat-exporter\.net\)/gi, '')
          .trim();
      }

      return messages.map(({ expectsTimestamp, ...message }) => message);
    }

    function parseChatLog(rawText, format = 'auto') {
      const trimmed = String(rawText || '').trim();
      const isJsonLike = trimmed.startsWith('[') || trimmed.startsWith('{');

      if (format === 'json' || (format === 'auto' && isJsonLike)) {
        try {
          return parseJsonChatLog(rawText);
        } catch (err) {
          if (format === 'json') throw err;
          return parseTextChatLog(rawText);
        }
      }

      return parseTextChatLog(rawText);
    }

    function createImportCardItems(messages) {
      const cardItems = [];
      let i = 0;

      while (i < messages.length) {
        const msg = messages[i];
        const nextMsg = messages[i + 1];
        if (msg.role === 'user' && nextMsg && (nextMsg.role === 'assistant' || nextMsg.role === 'model')) {
          if (msg.content.length <= 500) {
            cardItems.push({
              role: 'dialogue',
              question: msg.content,
              content: nextMsg.content,
              timestamp: nextMsg.timestamp || msg.timestamp
            });
            i += 2;
            continue;
          }
        }

        cardItems.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content,
          timestamp: msg.timestamp
        });
        i += 1;
      }

      return cardItems;
    }

    return {
      parseChatLog,
      parseTextChatLog,
      parseJsonChatLog,
      createImportCardItems
    };
  };
})();
