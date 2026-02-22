// Path: html/js/qa.js
// ============================================================================
// QA.JS - Q&A feature: ask a question, get an answer, one at a time
// ============================================================================

var QA = {
  state: null,  // null (idle) or { id, asker, question, answer, state }
  MAX_CHARS: 280,

  applyMessage: function(data) {
    if (!data || !data.op) return;
    var op = data.op;

    if (op === 'qa_state' || op === 'qa_ask') {
      this.state = {
        id: data.id,
        asker: data.asker,
        question: data.question,
        answer: data.answer || null,
        state: data.state
      };
    } else if (op === 'qa_answer') {
      if (this.state && this.state.id === data.id) {
        this.state.answer = data.answer;
        this.state.state = 'answered';
      } else {
        this.state = {
          id: data.id,
          asker: data.asker,
          question: data.question,
          answer: data.answer,
          state: 'answered'
        };
      }
    } else if (op === 'qa_read') {
      this.state = null;
    }

    this.updateBadge();
    // Re-render if modal is open
    var modal = document.getElementById('qaModal');
    if (modal && modal.classList.contains('show')) {
      this.render();
    }
  },

  askQuestion: function(text) {
    if (!text || !text.trim()) return;
    WebSocketManager.sendQA({ op: 'qa_ask', question: text.trim().substring(0, this.MAX_CHARS) });
  },

  submitAnswer: function(text) {
    if (!text || !text.trim()) return;
    WebSocketManager.sendQA({ op: 'qa_answer', answer: text.trim().substring(0, this.MAX_CHARS) });
  },

  markRead: function() {
    WebSocketManager.sendQA({ op: 'qa_read' });
  },

  _getMyRole: function() {
    return (typeof App !== 'undefined' && App.myRole) ? App.myRole : null;
  },

  openModal: function() {
    // If answered and I'm the asker, auto-mark as read
    if (this.state && this.state.state === 'answered' && this.state.asker === this._getMyRole()) {
      this.markRead();
    }
    this.render();
    UI.showQAModal();
  },

  render: function() {
    var content = document.getElementById('qaContent');
    if (!content) return;
    var myRole = this._getMyRole();
    var s = this.state;

    // Idle — no active Q&A
    if (!s) {
      content.innerHTML =
        '<div class="qa-input-wrap">' +
          '<textarea id="qaInput" class="qa-input" placeholder="Ask a question..." maxlength="' + this.MAX_CHARS + '"></textarea>' +
          '<span id="qaCharCount" class="qa-char-count">' + this.MAX_CHARS + '</span>' +
        '</div>' +
        '<button id="qaSubmitBtn" class="qa-submit-btn" type="button" disabled>Ask</button>';
      this._wireInput('qaInput', 'qaCharCount', 'qaSubmitBtn');
      var submitBtn = document.getElementById('qaSubmitBtn');
      if (submitBtn) {
        submitBtn.addEventListener('click', function() {
          var input = document.getElementById('qaInput');
          if (input && input.value.trim()) {
            QA.askQuestion(input.value);
          }
        });
      }
      return;
    }

    // Pending — question asked, waiting for answer
    if (s.state === 'pending') {
      if (s.asker === myRole) {
        // I asked — waiting for their answer
        content.innerHTML =
          '<div class="qa-question-display">' +
            '<div class="qa-bubble-label">Your question</div>' +
            this._escapeHtml(s.question) +
          '</div>' +
          '<div class="qa-status">Waiting for their answer...</div>';
      } else {
        // They asked — I need to answer
        content.innerHTML =
          '<div class="qa-question-display">' +
            '<div class="qa-bubble-label">Their question</div>' +
            this._escapeHtml(s.question) +
          '</div>' +
          '<div class="qa-input-wrap">' +
            '<textarea id="qaInput" class="qa-input" placeholder="Type your answer..." maxlength="' + this.MAX_CHARS + '"></textarea>' +
            '<span id="qaCharCount" class="qa-char-count">' + this.MAX_CHARS + '</span>' +
          '</div>' +
          '<button id="qaSubmitBtn" class="qa-submit-btn" type="button" disabled>Answer</button>';
        this._wireInput('qaInput', 'qaCharCount', 'qaSubmitBtn');
        var answerBtn = document.getElementById('qaSubmitBtn');
        if (answerBtn) {
          answerBtn.addEventListener('click', function() {
            var input = document.getElementById('qaInput');
            if (input && input.value.trim()) {
              QA.submitAnswer(input.value);
            }
          });
        }
      }
      return;
    }

    // Answered — show both Q and A
    if (s.state === 'answered') {
      var html =
        '<div class="qa-pair">' +
          '<div class="qa-question-display">' +
            '<div class="qa-bubble-label">Question</div>' +
            this._escapeHtml(s.question) +
          '</div>' +
          '<div class="qa-answer-display">' +
            '<div class="qa-bubble-label">Answer</div>' +
            this._escapeHtml(s.answer) +
          '</div>' +
        '</div>';

      if (s.asker === myRole) {
        // I asked — I'm reading the answer; state will reset via markRead
        html += '<button id="qaResetBtn" class="qa-reset-btn" type="button">Ask Another</button>';
        content.innerHTML = html;
        var resetBtn = document.getElementById('qaResetBtn');
        if (resetBtn) {
          resetBtn.addEventListener('click', function() {
            UI.hideQAModal();
          });
        }
      } else {
        // They asked — I answered, waiting for them to read
        html += '<div class="qa-status">Waiting for them to read...</div>';
        content.innerHTML = html;
      }
      return;
    }
  },

  updateBadge: function() {
    var badge = document.getElementById('qaBadge');
    if (!badge) return;
    var myRole = this._getMyRole();
    var s = this.state;

    var showBadge = false;
    if (s && s.state === 'pending' && s.asker !== myRole) {
      showBadge = true;  // Responder sees badge (unanswered question)
    } else if (s && s.state === 'answered' && s.asker === myRole) {
      showBadge = true;  // Asker sees badge (answer ready)
    }

    badge.style.display = showBadge ? '' : 'none';
    badge.textContent = showBadge ? '1' : '';
  },

  _wireInput: function(inputId, countId, btnId) {
    var input = document.getElementById(inputId);
    var counter = document.getElementById(countId);
    var btn = document.getElementById(btnId);
    if (!input) return;

    input.addEventListener('input', function() {
      var remaining = QA.MAX_CHARS - input.value.length;
      if (counter) {
        counter.textContent = remaining;
        if (remaining <= 20) {
          counter.classList.add('warn');
        } else {
          counter.classList.remove('warn');
        }
      }
      if (btn) {
        btn.disabled = !input.value.trim();
      }
    });

    // Allow submit on Enter (without shift)
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (btn && !btn.disabled) btn.click();
      }
    });
  },

  _escapeHtml: function(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
};
