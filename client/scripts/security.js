(function () {
  window.MindChatModules = window.MindChatModules || {};

  window.MindChatModules.createSecurityModule = function createSecurityModule() {
    function sanitizeRenderedHtml(html) {
      const template = document.createElement('template');
      template.innerHTML = html || '';
      const allowedTags = new Set([
        'BR', 'SPAN', 'STRONG', 'CODE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'UL', 'OL', 'LI', 'BLOCKQUOTE', 'HR'
      ]);
      const allowedClasses = new Set(['markdown-gap']);

      const cleanNode = (node) => {
        [...node.childNodes].forEach(child => {
          if (child.nodeType === Node.ELEMENT_NODE) {
            if (!allowedTags.has(child.tagName)) {
              child.replaceWith(document.createTextNode(child.textContent || ''));
              return;
            }

            [...child.attributes].forEach(attr => {
              const name = attr.name.toLowerCase();
              if (name === 'class') {
                const classes = attr.value.split(/\s+/).filter(cls =>
                  allowedClasses.has(cls) || (/^language-[a-z0-9_-]+$/i.test(cls) && child.tagName === 'CODE')
                );
                if (classes.length) {
                  child.setAttribute('class', classes.join(' '));
                } else {
                  child.removeAttribute('class');
                }
              } else {
                child.removeAttribute(attr.name);
              }
            });

            cleanNode(child);
          } else if (child.nodeType !== Node.TEXT_NODE) {
            child.remove();
          }
        });
      };

      cleanNode(template.content);
      return template.innerHTML;
    }

    function renderMarkdown(text) {
      if (!text) return '';

      let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      html = html.replace(/```(\w*)\n([\s\S]*?)\n```/g, (match, lang, code) => {
        return `<pre><code class="language-${lang}">${code}</code></pre>`;
      });

      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

      const lines = html.split('\n');
      let listType = null;
      const resultLines = [];

      const closeList = () => {
        if (!listType) return;
        resultLines.push(`</${listType}>`);
        listType = null;
      };

      const openList = (type) => {
        if (listType === type) return;
        closeList();
        resultLines.push(`<${type}>`);
        listType = type;
      };

      for (let line of lines) {
        const isBlankLine = line.trim() === '';
        const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
        const unorderedMatch = line.match(/^\s*[*+-]\s+(.*)$/);
        const orderedMatch = line.match(/^\s*\d+[.)]\s+(.*)$/);
        const quoteMatch = line.match(/^\s{0,3}&gt;\s+(.+)$/);
        const dividerMatch = line.match(/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/);

        if (headingMatch) {
          closeList();
          const level = headingMatch[1].length;
          resultLines.push(`<h${level}>${headingMatch[2]}</h${level}>`);
        } else if (dividerMatch) {
          closeList();
          resultLines.push('<hr>');
        } else if (unorderedMatch) {
          openList('ul');
          resultLines.push(`<li>${unorderedMatch[1]}</li>`);
        } else if (orderedMatch) {
          openList('ol');
          resultLines.push(`<li>${orderedMatch[1]}</li>`);
        } else if (quoteMatch) {
          closeList();
          resultLines.push(`<blockquote>${quoteMatch[1]}</blockquote>`);
        } else if (isBlankLine && listType) {
          continue;
        } else {
          closeList();
          resultLines.push(line);
        }
      }
      closeList();

      const rendered = resultLines
        .join('\n')
        .replace(/(<\/?(?:h[1-6]|ul|ol|li|blockquote|hr|pre)\b[^>]*>)\n+/g, '$1')
        .replace(/\n+(<\/?(?:h[1-6]|ul|ol|li|blockquote|hr|pre)\b[^>]*>)/g, '$1')
        .replace(/\n{2,}/g, '<span class="markdown-gap"></span>')
        .replace(/\n/g, '<br>');

      return sanitizeRenderedHtml(rendered);
    }

    return {
      renderMarkdown,
      sanitizeRenderedHtml
    };
  };
})();
