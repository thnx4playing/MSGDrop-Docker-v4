// Path: html/js/trivia.js
// ============================================================================
// TRIVIA.JS - Trivia Duel game, extends GameEngine base class
// ============================================================================

var TRIVIA_CATEGORIES = [
  { id: null, name: 'Any Category',      icon: '\u{1F3B2}' },
  { id: 9,    name: 'General Knowledge',  icon: '\u{1F9E0}' },
  { id: 11,   name: 'Film',               icon: '\u{1F3AC}' },
  { id: 12,   name: 'Music',              icon: '\u{1F3B5}' },
  { id: 14,   name: 'Television',         icon: '\u{1F4FA}' },
  { id: 15,   name: 'Video Games',        icon: '\u{1F3AE}' },
  { id: 17,   name: 'Science & Nature',   icon: '\u{1F52C}' },
  { id: 21,   name: 'Sports',             icon: '\u{26BD}' },
  { id: 22,   name: 'Geography',          icon: '\u{1F30D}' },
  { id: 23,   name: 'History',            icon: '\u{1F4DC}' },
  { id: 27,   name: 'Animals',            icon: '\u{1F43E}' },
  { id: 31,   name: 'Anime & Manga',      icon: '\u{1F365}' },
];

window.TriviaGame = new (class extends GameEngine {

  constructor(config) {
    super(config);

    // ── Trivia-specific state (extends this.state from GameEngine) ──
    this.state.questionNum       = 0;
    this.state.totalQuestions     = 10;
    this.state.currentQuestion   = null;   // {question, category, options}
    this.state.myAnswer          = null;   // index of selected option
    this.state.answerStartTime   = 0;      // timestamp when question was shown
    this.state.scores            = { E: 0, M: 0 };
    this.state.questionHistory   = [];
    this.state.otherPlayerAnswered = false;
    this.state.categoryId        = null;
    this.state.categoryName      = null;
  }

  // =========================================================================
  //  OVERRIDES: GameEngine abstract methods
  // =========================================================================

  /**
   * Show category picker instead of immediately sending invite.
   */
  startNewGame() {
    if (!Messages.myRole) { alert('Please select your role first'); return; }
    if (!WebSocketManager.ws || WebSocketManager.ws.readyState !== 1) { alert('Not connected to server'); return; }
    this.showCategoryPicker();
    UI.hideGamesMenu();
  }

  showCategoryPicker() {
    this.removeCategoryPicker();
    var self = this;
    var overlay = document.createElement('div');
    overlay.className = 'trivia-category-picker';
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) self.removeCategoryPicker();
    });

    var panel = document.createElement('div');
    panel.className = 'trivia-cat-panel';

    var title = document.createElement('div');
    title.className = 'trivia-cat-title';
    title.textContent = 'Pick a Category';
    panel.appendChild(title);

    var grid = document.createElement('div');
    grid.className = 'trivia-cat-grid';

    TRIVIA_CATEGORIES.forEach(function(cat) {
      var btn = document.createElement('button');
      btn.className = 'trivia-cat-btn';
      btn.type = 'button';
      btn.innerHTML = '<span class="trivia-cat-icon">' + cat.icon + '</span><span class="trivia-cat-name">' + cat.name + '</span>';
      btn.addEventListener('click', function() {
        self.state.categoryId   = cat.id;
        self.state.categoryName = cat.id !== null ? cat.name : null;
        self.removeCategoryPicker();
        self._sendOp('trivia_invite', { categoryId: cat.id, categoryName: cat.id !== null ? cat.name : null });
      });
      grid.appendChild(btn);
    });

    panel.appendChild(grid);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    this._categoryPickerCleanup = function(e) {
      if (e.key === 'Escape') self.removeCategoryPicker();
    };
    document.addEventListener('keydown', this._categoryPickerCleanup);
  }

  removeCategoryPicker() {
    var overlay = document.querySelector('.trivia-category-picker');
    if (overlay) overlay.remove();
    if (this._categoryPickerCleanup) {
      document.removeEventListener('keydown', this._categoryPickerCleanup);
      this._categoryPickerCleanup = null;
    }
  }

  /**
   * Override to show category name in invite card subtitle.
   */
  handleInvite(data) {
    var fromPlayer = data.from;
    this.state.inviteId  = data.inviteId;
    this.state.invitedBy = fromPlayer;

    var self  = this;
    var isMine = (fromPlayer === Messages.myRole);
    var sub = data.categoryName ? '10 questions \u00B7 ' + data.categoryName : this.subtitle;

    if (typeof Messages !== 'undefined' && Messages.injectGameInvite) {
      Messages.injectGameInvite({
        id:       data.inviteId,
        role:     fromPlayer,
        status:   isMine ? 'waiting' : 'incoming',
        game:     this.prefix,
        icon:     this.icon,
        title:    this.title,
        subtitle: sub,
        onAccept:  function() { self.acceptInvite(); },
        onDecline: function() { self.declineInvite(); },
        onCancel:  function() { self.cancelInvite(); }
      });
    }
  }

  /**
   * Handle trivia_resume — rebuild game state from server snapshot on reconnect.
   */
  handleResume(data) {
    this.state.gameId            = data.gameId;
    this.state.questionNum       = data.questionNum;
    this.state.totalQuestions     = data.totalQuestions;
    this.state.scores            = data.scores;
    this.state.questionHistory   = data.questionHistory || [];
    this.state.otherPlayerAnswered = data.otherPlayerAnswered || false;

    if (data.phase === 'questionResult' && data.lastResult) {
      this.state.phase           = 'questionResult';
      this.state.currentQuestion = data.question;
      this.showModal();
      this.renderQuestionResult(data.lastResult);
    } else if (data.myAnswerSubmitted) {
      this.state.phase           = 'waiting';
      this.state.myAnswer        = data.myAnswerIdx;
      this.state.currentQuestion = data.question;
      this.showModal();
      this.renderQuestion();
      this.disableOptions();
      this.stopTimer();
      this.updateWaitingStatus();
    } else {
      this.state.phase           = 'answering';
      this.state.myAnswer        = null;
      this.state.currentQuestion = data.question;
      this.state.answerStartTime = Date.now();
      this.showModal();
      this.renderQuestion();
    }
  }

  /**
   * Handle game-specific ops that aren't part of the shared lifecycle.
   */
  handleGameOp(op, data) {
    if (op === 'trivia_started') {
      this.clearInviteCard();
      this.state.gameId            = data.gameId;
      this.state.questionNum       = data.question || 1;
      this.state.totalQuestions     = data.totalQuestions || 10;
      this.state.currentQuestion   = { question: data.questionText, category: data.category, options: data.options };
      this.state.phase             = 'answering';
      this.state.myAnswer          = null;
      this.state.otherPlayerAnswered = false;
      this.state.scores            = { E: 0, M: 0 };
      this.state.questionHistory   = [];
      this.state.answerStartTime   = Date.now();
      this.showModal();
      this.renderQuestion();
    }
    else if (op === 'trivia_opponent_answered') {
      if (data.player !== Messages.myRole) {
        this.state.otherPlayerAnswered = true;
        this.updateWaitingStatus();
      }
    }
    else if (op === 'trivia_question_result') {
      this.state.phase = 'questionResult';
      this.state.scores = data.totalScores;
      this.state.questionHistory.push(data);
      this.renderQuestionResult(data);
    }
    else if (op === 'trivia_next_question') {
      this.state.questionNum       = data.question;
      this.state.totalQuestions     = data.totalQuestions || this.state.totalQuestions;
      this.state.currentQuestion   = { question: data.questionText, category: data.category, options: data.options };
      this.state.phase             = 'answering';
      this.state.myAnswer          = null;
      this.state.otherPlayerAnswered = false;
      this.state.answerStartTime   = Date.now();
      this.renderQuestion();
    }
    else if (op === 'trivia_game_end') {
      this.state.phase  = 'summary';
      this.state.scores = data.totalScores;
      this.renderGameSummary(data);
    }
  }

  /**
   * Reconnect handler — restore phase and restart timer after pause overlay is removed.
   */
  handlePlayerReconnected(data) {
    super.handlePlayerReconnected(data);
    if (data.player === Messages.myRole) return;
    if (!this.state.gameId) return;

    if (this.state.myAnswer !== null) {
      this.state.phase = 'waiting';
    } else {
      this.state.phase = 'answering';
      this.startTriviaTimer();
    }
  }

  /**
   * Reset trivia-specific state on top of the shared reset.
   */
  resetState() {
    super.resetState();
    this.state.questionNum         = 0;
    this.state.totalQuestions       = 10;
    this.state.currentQuestion     = null;
    this.state.myAnswer            = null;
    this.state.answerStartTime     = 0;
    this.state.scores              = { E: 0, M: 0 };
    this.state.questionHistory     = [];
    this.state.otherPlayerAnswered = false;
    this.state.categoryId          = null;
    this.state.categoryName        = null;
  }

  /**
   * Render the current question UI (called by renderGame contract and internally).
   */
  renderGame() {
    this.renderQuestion();
  }

  /**
   * Override renderForfeitMessage for trivia-specific UI.
   */
  renderForfeitMessage() {
    var gameArea    = document.getElementById('triviaGameArea');
    var summaryArea = document.getElementById('triviaSummaryArea');
    if (gameArea) gameArea.style.display = 'none';
    if (summaryArea) {
      summaryArea.style.display = 'block';
      summaryArea.innerHTML = '<div class="trivia-summary-title">Other player left the game</div>';
    }
  }

  // =========================================================================
  //  GAME-SPECIFIC METHODS
  // =========================================================================

  renderQuestion() {
    var roundLabel = document.getElementById('triviaRoundLabel');
    if (roundLabel) roundLabel.textContent = 'Q' + this.state.questionNum + ' of ' + this.state.totalQuestions;
    this.updateScoreDisplay();

    var gameArea       = document.getElementById('triviaGameArea');
    var summaryArea    = document.getElementById('triviaSummaryArea');
    var scoreboardArea = document.getElementById('triviaScoreboardArea');
    if (gameArea)       gameArea.style.display = 'flex';
    if (summaryArea)    summaryArea.style.display = 'none';
    if (scoreboardArea) scoreboardArea.style.display = 'none';

    var q = this.state.currentQuestion;
    if (!q) return;

    var categoryEl = document.getElementById('triviaCategory');
    if (categoryEl) { categoryEl.textContent = q.category || 'General'; categoryEl.style.display = ''; }
    var questionEl = document.getElementById('triviaQuestion');
    if (questionEl) questionEl.textContent = q.question;

    var optionsContainer = document.getElementById('triviaOptions');
    if (!optionsContainer) return;
    optionsContainer.innerHTML = '';
    var self = this;
    (q.options || []).forEach(function(opt, idx) {
      var btn = document.createElement('button');
      btn.className = 'trivia-option';
      btn.type = 'button';
      btn.textContent = opt;
      btn.setAttribute('data-idx', idx);
      btn.addEventListener('click', function() { self.selectAnswer(idx); });
      optionsContainer.appendChild(btn);
    });

    var timerBar = document.getElementById('triviaTimerFill');
    if (timerBar) { timerBar.style.width = '100%'; timerBar.style.transition = 'none'; }

    var resultText  = document.getElementById('triviaResultText');
    if (resultText)  resultText.textContent = '';
    var waitingText = document.getElementById('triviaWaiting');
    if (waitingText) waitingText.textContent = '';

    var nextBtn = document.getElementById('triviaNextBtn');
    if (nextBtn) nextBtn.style.display = 'none';

    this.startTriviaTimer();
  }

  selectAnswer(idx) {
    if (this.state.phase !== 'answering' || this.state.myAnswer !== null) return;
    this.state.myAnswer = idx;
    this.state.phase    = 'waiting';
    var timeMs = Date.now() - this.state.answerStartTime;

    // Highlight selected
    var buttons = document.querySelectorAll('.trivia-option');
    buttons.forEach(function(btn, i) {
      if (i === idx) btn.classList.add('selected');
      btn.disabled = true;
    });

    this.stopTimer();
    this._sendOp('trivia_answer', { gameId: this.state.gameId, answerIdx: idx, timeMs: timeMs });
    this.updateWaitingStatus();
  }

  disableOptions() {
    var buttons = document.querySelectorAll('.trivia-option');
    buttons.forEach(function(btn) { btn.disabled = true; });
    if (this.state.myAnswer !== null) {
      var selected = document.querySelector('.trivia-option[data-idx="' + this.state.myAnswer + '"]');
      if (selected) selected.classList.add('selected');
    }
  }

  updateWaitingStatus() {
    var el = document.getElementById('triviaWaiting');
    if (!el) return;
    var other = Messages.myRole === 'E' ? 'M' : 'E';
    if (this.state.phase === 'waiting') {
      el.textContent = this.state.otherPlayerAnswered ? 'Processing...' : 'Waiting for ' + other + '...';
    }
  }

  renderQuestionResult(data) {
    this.stopTimer();
    // data: {correctIdx, results: {E: {answerIdx, correct, score, timeMs}, M: {...}}, totalScores}
    var buttons = document.querySelectorAll('.trivia-option');
    buttons.forEach(function(btn, i) {
      btn.disabled = true;
      if (i === data.correctIdx) btn.classList.add('correct');
      ['E', 'M'].forEach(function(p) {
        if (data.results[p] && data.results[p].answerIdx === i && !data.results[p].correct) {
          btn.classList.add('wrong');
        }
      });
    });

    var resultText = document.getElementById('triviaResultText');
    if (resultText) {
      var html = '';
      ['E', 'M'].forEach(function(p) {
        var r = data.results[p];
        if (!r) return;
        var color = p === 'E' ? '#ef4444' : '#3b82f6';
        html += '<span style="color:' + color + ';font-weight:700">' + p + '</span>: ';
        html += r.correct ? '+' + r.score + ' pts' : 'Wrong';
        html += '  ';
      });
      resultText.innerHTML = html;
    }

    this.updateScoreDisplay();

    // Show next button after brief delay
    var nextBtn = document.getElementById('triviaNextBtn');
    if (nextBtn) {
      nextBtn.style.display = this.state.questionNum >= this.state.totalQuestions ? 'none' : '';
    }
    var waitingText = document.getElementById('triviaWaiting');
    if (waitingText) waitingText.textContent = '';
  }

  renderGameSummary(data) {
    var gameArea    = document.getElementById('triviaGameArea');
    var summaryArea = document.getElementById('triviaSummaryArea');
    if (gameArea)    gameArea.style.display = 'none';
    if (summaryArea) summaryArea.style.display = 'block';

    var html = '<div class="trivia-summary-title">';
    if (data.winner === 'tie')                html += "It's a tie!";
    else if (data.winner === Messages.myRole) html += 'You win!';
    else                                      html += data.winner + ' wins!';
    html += '</div>';
    html += '<div class="trivia-summary-scores">';
    html += '<div class="trivia-summary-player' + (data.winner === 'E' ? ' winner' : '') + '">E: ' + data.totalScores.E + '</div>';
    html += '<div class="trivia-summary-player' + (data.winner === 'M' ? ' winner' : '') + '">M: ' + data.totalScores.M + '</div>';
    html += '</div>';
    summaryArea.innerHTML = html;
  }

  renderScoreboard(data) {
    this.showModal();
    var gameArea       = document.getElementById('triviaGameArea');
    var summaryArea    = document.getElementById('triviaSummaryArea');
    var scoreboardArea = document.getElementById('triviaScoreboardArea');
    if (gameArea)    gameArea.style.display = 'none';
    if (summaryArea) summaryArea.style.display = 'none';
    if (!scoreboardArea) return;
    scoreboardArea.style.display = 'block';
    this.state.phase = 'scoreboard';
    var roundLabel = document.getElementById('triviaRoundLabel');
    if (roundLabel) roundLabel.textContent = 'Trivia History';
    var scoreDisplay = document.getElementById('triviaScoreDisplay');
    if (scoreDisplay) scoreDisplay.innerHTML = '';
    var html = '<div class="trivia-scoreboard-stats">E: ' + data.stats.eWins + ' wins | M: ' + data.stats.mWins + ' wins | Ties: ' + data.stats.ties + '</div>';
    if (!data.games || data.games.length === 0) {
      html += '<div style="text-align:center;color:var(--muted);padding:20px;">No games played yet</div>';
    } else {
      html += '<div class="trivia-scoreboard-games">';
      data.games.forEach(function(g) {
        var date = new Date(g.started_at).toLocaleDateString();
        html += '<div class="trivia-scoreboard-game"><span>' + date + '</span><span style="color:#ef4444;font-weight:600">' + g.e_total_score + '</span><span style="color:var(--muted)">vs</span><span style="color:#3b82f6;font-weight:600">' + g.m_total_score + '</span><span style="color:var(--muted);font-style:italic;margin-left:auto">' + (g.winner === 'tie' ? 'Tie' : g.winner + ' won') + '</span></div>';
      });
      html += '</div>';
    }
    scoreboardArea.innerHTML = html;
  }

  updateScoreDisplay() {
    var el = document.getElementById('triviaScoreDisplay');
    if (!el) return;
    el.innerHTML = '<span style="color:#ef4444;font-weight:600">E: ' + (this.state.scores.E || 0) + '</span><span style="color:var(--muted)"> \u2014 </span><span style="color:#3b82f6;font-weight:600">M: ' + (this.state.scores.M || 0) + '</span>';
  }

  // ─── Trivia-specific timer (shrinking bar + auto-timeout) ─────────────

  startTriviaTimer() {
    this.stopTimer();
    var timerEl   = document.getElementById('triviaTimer');
    var timerFill = document.getElementById('triviaTimerFill');
    if (timerEl) { timerEl.textContent = '15'; timerEl.classList.remove('warning'); }
    if (timerFill) {
      timerFill.style.transition = 'none';
      timerFill.style.width = '100%';
      timerFill.offsetHeight;  // force reflow
      timerFill.style.transition = 'width 15s linear';
      timerFill.style.width = '0%';
    }

    var self = this;
    this.startTimer(15,
      function onTick(remaining) {
        if (timerEl) {
          timerEl.textContent = remaining;
          if (remaining <= 5) timerEl.classList.add('warning');
        }
      },
      function onExpire() {
        if (self.state.phase === 'answering') {
          self.state.phase = 'waiting';
          self.disableOptions();
          self._sendOp('trivia_timeout', { gameId: self.state.gameId });
          self.updateWaitingStatus();
        }
      }
    );
  }

  nextQuestion() {
    this._sendOp('trivia_next', { gameId: this.state.gameId });
  }

})({
  prefix:        'trivia',
  icon:          '\u{1F9E0}',
  title:         'Trivia Duel',
  subtitle:      '10 questions \u00B7 15s each',
  modalId:       'triviaModal',
  panelClass:    'trivia-panel',
  showModal:     function() { UI.showTriviaModal(); },
  hideModal:     function() { UI.hideTriviaModal(); },
  scoreboardUrl: '/api/trivia/scores/'
});
