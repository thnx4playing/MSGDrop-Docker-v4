// Path: html/js/wordle.js
// ============================================================================
// WORDLE.JS - Wordle Battle game for MSGDrop v4
// ============================================================================
// Extends GameEngine for shared invite, timer, pause/resume, forfeit, and
// op-routing logic. Game-specific grid, keyboard, and guess logic below.
// ============================================================================

window.WordleGame = new (class extends GameEngine {

  constructor(config) {
    super(config);

    // ── Wordle-specific state (extends this.state from GameEngine) ──
    this.state.round          = 0;
    this.state.totalRounds    = 1;
    this.state.wordLength     = 5;
    this.state.currentRow     = 0;
    this.state.currentCol     = 0;
    this.state.maxAttempts    = 6;
    this.state.grid           = [];
    this.state.feedback       = [];
    this.state.keyStates      = {};
    this.state.scores         = {E: 0, M: 0};
    this.state.roundHistory   = [];
    this.state.myAttempts     = 0;
    this.state.solved         = false;
    this.state.otherPlayerDone = false;
    this.state.roundWord      = null;
    this.state.hintUsed        = false;

    this._keyboardHandler = null;
  }

  // =========================================================================
  //  OVERRIDES — required by GameEngine
  // =========================================================================

  /**
   * Handle wordle_resume — rebuild the game UI from a server snapshot.
   */
  handleResume(data) {
    this.state.gameId       = data.gameId;
    this.state.round        = data.round;
    this.state.totalRounds  = data.totalRounds;
    this.state.wordLength   = data.wordLength || 5;
    this.state.scores       = data.scores || {E: 0, M: 0};
    this.state.roundHistory = data.roundHistory || [];
    this.state.otherPlayerDone = data.otherPlayerDone || false;

    // Rebuild grid from server snapshot
    if (data.myGrid && data.myGrid.length > 0) {
      this.state.grid = [];
      for (var r = 0; r < this.state.maxAttempts; r++) {
        if (r < data.myGrid.length) {
          var row = [];
          for (var c = 0; c < this.state.wordLength; c++) {
            if (c < data.myGrid[r].length) {
              row.push({
                letter: (data.myGrid[r][c].letter || '').toUpperCase(),
                state: data.myGrid[r][c].state || 'empty'
              });
            } else {
              row.push({letter: '', state: 'empty'});
            }
          }
          this.state.grid.push(row);
        } else {
          var emptyRow = [];
          for (var j = 0; j < this.state.wordLength; j++) {
            emptyRow.push({letter: '', state: 'empty'});
          }
          this.state.grid.push(emptyRow);
        }
      }
    } else {
      this.initGrid();
    }

    // Rebuild key states from server snapshot
    this.state.keyStates = {};
    if (data.myKeyStates) {
      for (var k in data.myKeyStates) {
        if (data.myKeyStates.hasOwnProperty(k)) {
          this.state.keyStates[k.toUpperCase()] = data.myKeyStates[k];
        }
      }
    }

    this.state.myAttempts = data.myAttempts || 0;
    this.state.solved     = data.mySolved || false;
    this.state.hintUsed   = data.hintUsed || false;
    this.state.currentRow = this.state.myAttempts;
    this.state.currentCol = 0;

    // Determine phase and render accordingly
    if (data.phase === 'result' || data.phase === 'round_result') {
      this.state.phase = 'result';
      this.showModal();
      if (data.roundResult) {
        this.renderRoundResult(data.roundResult);
      } else {
        this.renderPlaying();
        this.updateMessage('Waiting for round result...');
      }
    } else if (this.state.solved || this.state.currentRow >= this.state.maxAttempts) {
      this.state.phase = 'waiting';
      this.showModal();
      this.renderPlaying();
      this.stopTimer();
      this.removeKeyboardListener();
      this.updateMessage(this.state.solved ? 'Solved! Waiting for other player...' : 'Out of attempts. Waiting...');
    } else {
      this.state.phase = 'playing';
      this.showModal();
      this.renderPlaying();
    }
  }

  /**
   * Handle game-specific ops that are not part of the shared lifecycle.
   */
  handleGameOp(op, data) {
    if (op === 'wordle_started') {
      this.clearInviteCard();
      this.state.gameId      = data.gameId;
      this.state.round       = data.round;
      this.state.totalRounds = data.totalRounds;
      this.state.wordLength  = data.wordLength || 5;
      this.state.phase       = 'playing';
      this.state.scores      = {E: 0, M: 0};
      this.state.roundHistory = [];
      this.initGrid();
      this.showModal();
      this.renderPlaying();
    }

    else if (op === 'wordle_guess_result') {
      if (data.player === Messages.myRole) {
        this.applyFeedback(data.attempt - 1, data.feedback, data.isCorrect);
      }
    }

    else if (op === 'wordle_invalid_word') {
      this.shakeRow(this.state.currentRow);
      this.updateMessage('Not in word list');
      var self = this;
      setTimeout(function() { self.updateMessage(''); }, 1500);
    }

    else if (op === 'wordle_opponent_progress') {
      if (data.player !== Messages.myRole) {
        this.updateMessage(data.player + ': attempt ' + data.attempt + '/6');
      }
    }

    else if (op === 'wordle_hint_result') {
      this.state.hintUsed = true;
      var pos = data.position;
      var letter = data.letter.toUpperCase();
      var row = this.state.currentRow;
      if (row < this.state.maxAttempts) {
        this.state.grid[row][pos].letter = letter;
        if (this.state.currentCol <= pos) {
          this.state.currentCol = pos + 1;
        }
      }
      this.renderGrid();
      this.renderHintButton();
      var cell = document.querySelector('.wordle-cell[data-row="' + row + '"][data-col="' + pos + '"]');
      if (cell) cell.classList.add('hint-reveal');
      this.updateMessage('Position ' + (pos + 1) + ' is ' + letter);
      var self = this;
      setTimeout(function() { self.updateMessage(''); }, 2000);
    }

    else if (op === 'wordle_hint_denied') {
      this.state.hintUsed = true;
      this.renderHintButton();
    }

    else if (op === 'wordle_round_result') {
      this.state.phase = 'result';
      this.state.scores = data.totalScores;
      this.state.roundWord = data.word;
      this.state.roundHistory.push(data);
      this.renderRoundResult(data);
    }

    else if (op === 'wordle_next_round') {
      this.state.round       = data.round;
      this.state.wordLength  = data.wordLength || 5;
      this.state.phase       = 'playing';
      this.initGrid();
      this.renderPlaying();
    }

    else if (op === 'wordle_game_end') {
      this.state.phase  = 'summary';
      this.state.scores = data.totalScores;
      this.stopTimer();
      this.removeKeyboardListener();
      this.renderGameSummary(data);
    }
  }

  /**
   * Handle forfeit — override to also remove the keyboard listener.
   */
  handleForfeit(data) {
    if (data.player !== Messages.myRole) {
      this.state.phase = 'summary';
      this.stopTimer();
      this.removeKeyboardListener();
      this.renderForfeitMessage();
    }
  }

  /**
   * Handle reconnection — restore phase and timer after base class cleans up
   * the pause overlay and chat card.
   */
  handlePlayerReconnected(data) {
    super.handlePlayerReconnected(data);
    if (data.player === Messages.myRole) return;
    if (!this.state.gameId) return;

    if (this.state.solved || this.state.currentRow >= this.state.maxAttempts) {
      this.state.phase = 'waiting';
    } else {
      this.state.phase = 'playing';
      this.startWordleTimer();
    }
  }

  /**
   * Reset all state — shared + wordle-specific.
   */
  resetState() {
    super.resetState();
    this.removeKeyboardListener();
    this.state.round           = 0;
    this.state.currentRow      = 0;
    this.state.currentCol      = 0;
    this.state.grid            = [];
    this.state.feedback        = [];
    this.state.keyStates       = {};
    this.state.scores          = {E: 0, M: 0};
    this.state.roundHistory    = [];
    this.state.solved          = false;
    this.state.otherPlayerDone = false;
    this.state.myAttempts      = 0;
    this.state.roundWord       = null;
    this.state.hintUsed        = false;
  }

  /**
   * Render the game (called by base class after state changes).
   */
  renderGame() {
    this.renderPlaying();
  }

  // =========================================================================
  //  GRID MANAGEMENT
  // =========================================================================

  initGrid() {
    this.state.grid       = [];
    this.state.feedback   = [];
    this.state.keyStates  = {};
    this.state.currentRow = 0;
    this.state.currentCol = 0;
    this.state.solved     = false;
    this.state.otherPlayerDone = false;
    this.state.myAttempts = 0;
    this.state.hintUsed = false;
    for (var i = 0; i < this.state.maxAttempts; i++) {
      var row = [];
      for (var j = 0; j < this.state.wordLength; j++) {
        row.push({letter: '', state: 'empty'});
      }
      this.state.grid.push(row);
    }
  }

  // =========================================================================
  //  INPUT HANDLING
  // =========================================================================

  handleKeyPress(key) {
    if (this.state.phase !== 'playing' || this.state.solved || this.state.currentRow >= this.state.maxAttempts) return;

    key = key.toUpperCase();
    if (key === 'BACKSPACE' || key === '\u2190') {
      if (this.state.currentCol > 0) {
        this.state.currentCol--;
        this.state.grid[this.state.currentRow][this.state.currentCol].letter = '';
        this.renderGrid();
      }
    } else if (key === 'ENTER') {
      this.submitGuess();
    } else if (/^[A-Z]$/.test(key) && this.state.currentCol < this.state.wordLength) {
      this.state.grid[this.state.currentRow][this.state.currentCol].letter = key;
      this.state.currentCol++;
      this.renderGrid();
    }
  }

  submitGuess() {
    if (this.state.currentCol !== this.state.wordLength) return;
    var word = '';
    for (var i = 0; i < this.state.wordLength; i++) {
      word += this.state.grid[this.state.currentRow][i].letter;
    }
    this._sendOp('wordle_guess', {gameId: this.state.gameId, word: word.toLowerCase()});
  }

  applyFeedback(row, feedback, isCorrect) {
    for (var i = 0; i < feedback.length; i++) {
      this.state.grid[row][i].state = feedback[i].state;
      this.state.grid[row][i].letter = feedback[i].letter.toUpperCase();
      var letter = feedback[i].letter.toUpperCase();
      var currentState = this.state.keyStates[letter];
      var newState = feedback[i].state;
      if (!currentState ||
          (newState === 'correct') ||
          (newState === 'present' && currentState !== 'correct')) {
        this.state.keyStates[letter] = newState;
      }
    }
    this.state.myAttempts = row + 1;
    if (isCorrect) {
      this.state.solved = true;
    }
    this.state.currentRow = row + 1;
    this.state.currentCol = 0;

    if (this.state.solved || this.state.currentRow >= this.state.maxAttempts) {
      if (this.state.otherPlayerDone) {
        this.updateMessage('Waiting for results...');
      } else {
        this.state.phase = 'waiting';
        this.updateMessage(this.state.solved ? 'Solved! Waiting for other player...' : 'Out of attempts. Waiting...');
      }
      this.stopTimer();
      this.removeKeyboardListener();
    }

    this.renderGrid();
    this.renderKeyboard();
  }

  shakeRow(row) {
    var cells = document.querySelectorAll('.wordle-cell[data-row="' + row + '"]');
    cells.forEach(function(c) {
      c.classList.add('shake');
      setTimeout(function() { c.classList.remove('shake'); }, 500);
    });
  }

  // =========================================================================
  //  RENDERING
  // =========================================================================

  renderPlaying() {
    var roundLabel = document.getElementById('wordleRoundLabel');
    if (roundLabel) roundLabel.textContent = 'Wordle Battle';
    this.updateScoreDisplay();

    var gameArea       = document.getElementById('wordleGameArea');
    var resultArea     = document.getElementById('wordleResultArea');
    var summaryArea    = document.getElementById('wordleSummaryArea');
    var scoreboardArea = document.getElementById('wordleScoreboardArea');
    if (gameArea) gameArea.style.display = 'flex';
    if (resultArea) resultArea.style.display = 'none';
    if (summaryArea) summaryArea.style.display = 'none';
    if (scoreboardArea) scoreboardArea.style.display = 'none';

    this.renderGrid();
    this.renderKeyboard();
    this.updateMessage('');
    this.renderHintButton();

    if (this.state.phase === 'playing') {
      this.startWordleTimer();
      this.setupKeyboardListener();
    }
  }

  renderGrid() {
    var container = document.getElementById('wordleGrid');
    if (!container) return;
    container.innerHTML = '';
    var self = this;
    for (var r = 0; r < this.state.maxAttempts; r++) {
      var rowEl = document.createElement('div');
      rowEl.className = 'wordle-row';
      for (var c = 0; c < this.state.wordLength; c++) {
        var cell = document.createElement('div');
        cell.className = 'wordle-cell';
        cell.setAttribute('data-row', r);
        cell.setAttribute('data-col', c);
        var cellData = this.state.grid[r][c];
        if (cellData.letter) {
          cell.textContent = cellData.letter;
          if (cellData.state !== 'empty') {
            cell.classList.add(cellData.state);
          } else {
            cell.classList.add('filled');
          }
        }
        rowEl.appendChild(cell);
      }
      // GO button: show on current row when all 5 letters filled, still playing
      if (r === this.state.currentRow && this.state.currentCol === this.state.wordLength
          && this.state.phase === 'playing' && !this.state.solved) {
        var goBtn = document.createElement('button');
        goBtn.className = 'wordle-row-submit';
        goBtn.type = 'button';
        goBtn.textContent = 'GO';
        goBtn.addEventListener('click', function() { self.submitGuess(); });
        rowEl.appendChild(goBtn);
      }
      container.appendChild(rowEl);
    }
  }

  renderKeyboard() {
    var container = document.getElementById('wordleKeyboard');
    if (!container) return;
    container.innerHTML = '';
    var rows = [
      ['Q','W','E','R','T','Y','U','I','O','P'],
      ['A','S','D','F','G','H','J','K','L'],
      ['ENTER','Z','X','C','V','B','N','M','\u2190']
    ];
    var self = this;
    rows.forEach(function(row) {
      var rowEl = document.createElement('div');
      rowEl.className = 'wordle-kb-row';
      row.forEach(function(key) {
        var btn = document.createElement('button');
        btn.className = 'wordle-key';
        btn.type = 'button';
        btn.textContent = key === 'ENTER' ? '\u21B5' : key;
        if (key === 'ENTER' || key === '\u2190') btn.classList.add('wide');
        var state = self.state.keyStates[key];
        if (state) btn.classList.add(state);
        btn.addEventListener('click', function() { self.handleKeyPress(key); });
        rowEl.appendChild(btn);
      });
      container.appendChild(rowEl);
    });
  }

  renderHintButton() {
    var area = document.getElementById('wordleHintArea');
    if (!area) return;
    if (this.state.phase !== 'playing' && this.state.phase !== 'waiting') {
      area.innerHTML = '';
      return;
    }
    if (this.state.hintUsed) {
      area.innerHTML = '<span style="color:var(--muted);font-size:12px;">Hint used</span>';
      return;
    }
    var self = this;
    area.innerHTML = '';
    var btn = document.createElement('button');
    btn.className = 'wordle-hint-btn';
    btn.type = 'button';
    btn.innerHTML = '\uD83D\uDCA1 Hint';
    btn.addEventListener('click', function() { self.requestHint(); });
    area.appendChild(btn);
  }

  requestHint() {
    if (this.state.hintUsed || this.state.phase !== 'playing') return;
    this._sendOp('wordle_hint', {gameId: this.state.gameId});
  }

  setupKeyboardListener() {
    this.removeKeyboardListener();
    var self = this;
    this._keyboardHandler = function(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Backspace') { e.preventDefault(); self.handleKeyPress('BACKSPACE'); }
      else if (e.key === 'Enter') { e.preventDefault(); self.handleKeyPress('ENTER'); }
      else if (/^[a-zA-Z]$/.test(e.key)) { self.handleKeyPress(e.key); }
    };
    window.addEventListener('keydown', this._keyboardHandler);
  }

  removeKeyboardListener() {
    if (this._keyboardHandler) {
      window.removeEventListener('keydown', this._keyboardHandler);
      this._keyboardHandler = null;
    }
  }

  renderRoundResult(data) {
    this.stopTimer();
    this.removeKeyboardListener();
    var gameArea   = document.getElementById('wordleGameArea');
    var resultArea = document.getElementById('wordleResultArea');
    if (gameArea) gameArea.style.display = 'none';
    if (resultArea) resultArea.style.display = 'flex';

    var html = '<div class="wordle-result-word">The word was: <strong>' + (data.word || '?').toUpperCase() + '</strong></div>';
    html += '<div class="wordle-result-grids">';
    ['E','M'].forEach(function(p) {
      var r = data.results[p];
      if (!r) return;
      var scoreText = r.solved ? 'Solved in ' + r.attempts + ' (' + r.score + ' pts)' : 'Failed (0 pts)';
      html += '<div class="wordle-result-player"><div class="wordle-result-player-label" style="color:' + (p === 'E' ? '#ef4444' : '#3b82f6') + '">' + p + '</div>';
      html += '<div class="wordle-mini-grid">';
      if (r.grid) {
        r.grid.forEach(function(row) {
          row.forEach(function(cell) {
            html += '<div class="wordle-mini-cell ' + (cell.state || 'empty') + '"></div>';
          });
        });
      }
      html += '</div>';
      html += '<div class="wordle-result-score">' + scoreText + '</div></div>';
    });
    html += '</div>';

    resultArea.innerHTML = html;
    this.updateScoreDisplay();

    var nextBtn = document.getElementById('wordleNextBtn');
    if (nextBtn) {
      nextBtn.style.display = this.state.round >= this.state.totalRounds ? 'none' : '';
    }
  }

  renderGameSummary(data) {
    var gameArea    = document.getElementById('wordleGameArea');
    var resultArea  = document.getElementById('wordleResultArea');
    var summaryArea = document.getElementById('wordleSummaryArea');
    if (gameArea) gameArea.style.display = 'none';
    if (resultArea) resultArea.style.display = 'none';
    if (summaryArea) {
      summaryArea.style.display = 'flex';
      summaryArea.innerHTML = this.buildEndSummaryHTML(data);
    }
  }

  renderForfeitMessage() {
    var gameArea    = document.getElementById('wordleGameArea');
    var resultArea  = document.getElementById('wordleResultArea');
    var summaryArea = document.getElementById('wordleSummaryArea');
    if (gameArea) gameArea.style.display = 'none';
    if (resultArea) resultArea.style.display = 'none';
    if (summaryArea) {
      summaryArea.style.display = 'block';
      summaryArea.innerHTML = '<div class="wordle-summary-title">Other player left the game</div>';
    }
  }

  updateScoreDisplay() {
    var el = document.getElementById('wordleScoreDisplay');
    if (!el) return;
    el.innerHTML = '<span style="color:#ef4444;font-weight:600">E: ' + (this.state.scores.E || 0) + '</span>' +
      '<span style="color:var(--muted)"> \u2014 </span>' +
      '<span style="color:#3b82f6;font-weight:600">M: ' + (this.state.scores.M || 0) + '</span>';
  }

  updateMessage(text) {
    var el = document.getElementById('wordleMessage');
    if (el) el.textContent = text || '';
  }

  // =========================================================================
  //  WORDLE-SPECIFIC TIMER (120s with timeout op)
  // =========================================================================

  startWordleTimer() {
    var self = this;
    var timerEl = document.getElementById('wordleTimer');

    this.startTimer(300,
      // onTick
      function(s) {
        if (timerEl) {
          timerEl.textContent = self.getTimerDisplay(s);
          if (s <= 10) timerEl.classList.add('warning');
          else timerEl.classList.remove('warning');
        }
      },
      // onExpire
      function() {
        if (self.state.phase === 'playing' && !self.state.solved && self.state.currentRow < self.state.maxAttempts) {
          self.state.phase = 'waiting';
          self.updateMessage('Time\'s up! Waiting for results...');
          self.removeKeyboardListener();
          self._sendOp('wordle_timeout', {gameId: self.state.gameId});
        }
      }
    );
  }

  // =========================================================================
  //  NEXT ROUND
  // =========================================================================

  nextRound() {
    this._sendOp('wordle_next', {gameId: this.state.gameId});
  }

  // =========================================================================
  //  SCOREBOARD (override to render wordle-specific UI)
  // =========================================================================

  renderScoreboard(data) {
    this.showModal();
    var gameArea       = document.getElementById('wordleGameArea');
    var resultArea     = document.getElementById('wordleResultArea');
    var summaryArea    = document.getElementById('wordleSummaryArea');
    var scoreboardArea = document.getElementById('wordleScoreboardArea');
    if (gameArea) gameArea.style.display = 'none';
    if (resultArea) resultArea.style.display = 'none';
    if (summaryArea) summaryArea.style.display = 'none';
    if (!scoreboardArea) return;
    scoreboardArea.style.display = 'block';
    this.state.phase = 'scoreboard';

    var roundLabel = document.getElementById('wordleRoundLabel');
    if (roundLabel) roundLabel.textContent = 'Wordle History';
    var scoreDisplay = document.getElementById('wordleScoreDisplay');
    if (scoreDisplay) scoreDisplay.innerHTML = '';

    var html = '<div class="wordle-scoreboard-stats">E: ' + data.stats.eWins + ' wins | M: ' + data.stats.mWins + ' wins | Ties: ' + data.stats.ties + '</div>';
    if (!data.games || data.games.length === 0) {
      html += '<div style="text-align:center;color:var(--muted);padding:20px;">No games played yet</div>';
    } else {
      html += '<div class="wordle-scoreboard-games">';
      data.games.forEach(function(g) {
        var date = new Date(g.started_at).toLocaleDateString();
        html += '<div class="wordle-scoreboard-game"><span class="wordle-sg-date">' + date + '</span><span class="wordle-sg-e">' + g.e_total_score + '</span><span style="color:var(--muted)">vs</span><span class="wordle-sg-m">' + g.m_total_score + '</span><span class="wordle-sg-winner">' + (g.winner === 'tie' ? 'Tie' : g.winner + ' won') + '</span></div>';
      });
      html += '</div>';
    }
    scoreboardArea.innerHTML = html;
  }

})({
  prefix:        'wordle',
  icon:          '\uD83D\uDCDD',
  title:         'Wordle Battle',
  subtitle:      '1 round \u00b7 5 min',
  modalId:       'wordleModal',
  panelClass:    'wordle-panel',
  showModal:     function() { UI.showWordleModal(); },
  hideModal:     function() { UI.hideWordleModal(); },
  scoreboardUrl: '/api/wordle/scores/'
});
