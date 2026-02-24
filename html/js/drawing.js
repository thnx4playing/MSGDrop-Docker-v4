// Path: html/js/drawing.js
// ============================================================================
// DRAWING.JS - Drawing Guess game client for MSGDrop v4
// ============================================================================
// Extends GameEngine for shared invite lifecycle, timer, pause/resume,
// forfeit, close/reset, and op routing.  Game-specific canvas drawing,
// stroke streaming, guess checking, and round/summary rendering stay here.
// ============================================================================

window.DrawingGame = new (class extends GameEngine {

  constructor(config) {
    super(config);

    // ── Drawing-specific state ──
    this.state.round        = 0;
    this.state.totalRounds  = 6;
    this.state.isDrawer     = false;
    this.state.currentWord  = null;
    this.state.wordLength   = 0;
    this.state.wrongGuesses = [];
    this.state.scores       = {E: 0, M: 0};
    this.state.roundHistory = [];
    this.state.isDrawing    = false;
    this.state.currentColor = '#000000';
    this.state.brushSize    = 4;
    this.state.strokeBuffer = [];
    this.state.strokeSendTimer = null;
    this.state.allStrokes   = [];

    this.canvas     = null;
    this.ctx        = null;
    this.colors     = ['#000000','#ef4444','#3b82f6','#22c55e','#eab308','#a855f7','#ec4899','#ffffff'];
    this.brushSizes = [2, 4, 8];
  }

  // =========================================================================
  //  GAME-ENGINE OVERRIDES
  // =========================================================================

  /**
   * Handle disconnect: flush pending strokes before delegating to base class.
   */
  handlePlayerDisconnected(data) {
    if (data.player !== Messages.myRole && this.state.gameId) {
      this.flushStrokes();
    }
    super.handlePlayerDisconnected(data);
  }

  /**
   * Handle reconnect: restore phase and restart timer after base removes overlay.
   */
  handlePlayerReconnected(data) {
    super.handlePlayerReconnected(data);
    if (data.player !== Messages.myRole && this.state.gameId) {
      this.state.phase = this.state.isDrawer ? 'drawing' : 'guessing';
      this._startRoundTimer();
    }
  }

  /**
   * Handle resume op -- rebuild the game UI from a server snapshot.
   */
  handleResume(data) {
    this.state.gameId       = data.gameId;
    this.state.round        = data.round;
    this.state.totalRounds  = data.totalRounds || 6;
    this.state.scores       = data.scores;
    this.state.roundHistory = data.roundHistory || [];
    this.state.isDrawer     = data.drawer === Messages.myRole;
    this.state.currentWord  = data.word || null;
    this.state.wordLength   = data.wordLength || 0;
    this.state.wrongGuesses = data.wrongGuesses || [];
    this.state.allStrokes   = [];

    if (data.phase === 'roundResult') {
      this.state.phase = 'roundResult';
      this.showModal();
      this.renderRoundResult(data.lastResult || {word: data.currentWord || '?', guessed: false});
    } else {
      this.state.phase = this.state.isDrawer ? 'drawing' : 'guessing';
      this.showModal();
      this.renderRound();
      // Replay accumulated strokes for guesser
      if (!this.state.isDrawer && data.strokes) {
        this.replayStrokes(data.strokes);
      }
    }
  }

  /**
   * Handle game-specific ops that are not part of the shared lifecycle.
   */
  handleGameOp(op, data) {
    // ROUND STARTED (per-player payload: drawer gets word, guesser gets wordLength)
    if (op === 'draw_started' || op === 'draw_next_round') {
      if (op === 'draw_started') {
        this.clearInviteCard();
        this.state.scores       = {E: 0, M: 0};
        this.state.roundHistory = [];
      }
      this.state.gameId       = data.gameId;
      this.state.round        = data.round;
      this.state.totalRounds  = data.totalRounds || 6;
      this.state.isDrawer     = data.drawer === Messages.myRole;
      this.state.currentWord  = data.word || null;
      this.state.wordLength   = data.wordLength || (data.word ? data.word.length : 0);
      this.state.wrongGuesses = [];
      this.state.allStrokes   = [];
      this.state.strokeBuffer = [];

      this.state.phase = this.state.isDrawer ? 'drawing' : 'guessing';

      this.showModal();
      this.renderRound();
    }
    // STROKES FROM DRAWER (received by guesser)
    else if (op === 'draw_strokes') {
      if (!this.state.isDrawer && data.strokes) {
        this.replayStrokes(data.strokes);
      }
    }
    // CANVAS CLEARED
    else if (op === 'draw_clear') {
      if (!this.state.isDrawer) {
        this.clearCanvas();
      }
    }
    // WRONG GUESS
    else if (op === 'draw_wrong_guess') {
      this.state.wrongGuesses.push(data.guess);
      this.renderWrongGuesses();
    }
    // ROUND RESULT (correct guess or timeout)
    else if (op === 'draw_round_result') {
      this.stopTimer();
      this.flushStrokes();
      this.state.scores = data.totalScores || this.state.scores;
      this.state.phase  = 'roundResult';
      this.state.roundHistory.push(data);
      this.renderRoundResult(data);
    }
    // GAME END
    else if (op === 'draw_game_end') {
      this.state.phase  = 'summary';
      this.state.scores = data.totalScores;
      this.renderGameSummary(data);
    }
  }

  /**
   * Reset drawing-specific state on top of base class reset.
   */
  resetState() {
    this.flushStrokes();
    this.removeDrawHandlers();
    super.resetState();
    this.state.round        = 0;
    this.state.totalRounds  = 6;
    this.state.isDrawer     = false;
    this.state.currentWord  = null;
    this.state.wordLength   = 0;
    this.state.wrongGuesses = [];
    this.state.scores       = {E: 0, M: 0};
    this.state.roundHistory = [];
    this.state.isDrawing    = false;
    this.state.currentColor = '#000000';
    this.state.brushSize    = 4;
    this.state.allStrokes   = [];
    this.state.strokeBuffer = [];
    this.state.strokeSendTimer = null;
    this.canvas = null;
    this.ctx    = null;
  }

  /**
   * Render the game UI (full re-render for current round).
   */
  renderGame() {
    this.renderRound();
  }

  /**
   * Render forfeit message in the summary area.
   */
  renderForfeitMessage() {
    var gameArea    = document.getElementById('drawGameArea');
    var resultArea  = document.getElementById('drawResultArea');
    var summaryArea = document.getElementById('drawSummaryArea');
    if (gameArea) gameArea.style.display = 'none';
    if (resultArea) resultArea.style.display = 'none';
    if (summaryArea) {
      summaryArea.style.display = 'block';
      summaryArea.innerHTML = '<div class="draw-summary-title">Other player left the game</div>';
    }
  }

  /**
   * Render the scoreboard for this game.
   */
  renderScoreboard(data) {
    this.showModal();
    var gameArea       = document.getElementById('drawGameArea');
    var resultArea     = document.getElementById('drawResultArea');
    var summaryArea    = document.getElementById('drawSummaryArea');
    var scoreboardArea = document.getElementById('drawScoreboardArea');
    if (gameArea) gameArea.style.display         = 'none';
    if (resultArea) resultArea.style.display     = 'none';
    if (summaryArea) summaryArea.style.display   = 'none';
    if (!scoreboardArea) return;
    scoreboardArea.style.display = 'block';
    this.state.phase = 'scoreboard';

    var roundLabel = document.getElementById('drawRoundLabel');
    if (roundLabel) roundLabel.textContent = 'Drawing History';
    var scoreDisplay = document.getElementById('drawScoreDisplay');
    if (scoreDisplay) scoreDisplay.innerHTML = '';

    var html = '<div class="draw-scoreboard-stats">E: ' + data.stats.eWins + ' wins | M: ' + data.stats.mWins + ' wins | Ties: ' + data.stats.ties + '</div>';
    if (!data.games || data.games.length === 0) {
      html += '<div style="text-align:center;color:var(--muted);padding:20px;">No games played yet</div>';
    } else {
      html += '<div class="draw-scoreboard-games">';
      data.games.forEach(function(g) {
        var date = new Date(g.started_at).toLocaleDateString();
        html += '<div class="draw-scoreboard-game"><span>' + date + '</span><span style="color:#ef4444;font-weight:600">' + g.e_total_score + '</span><span style="color:var(--muted)">vs</span><span style="color:#3b82f6;font-weight:600">' + g.m_total_score + '</span><span style="color:var(--muted);font-style:italic;margin-left:auto">' + (g.winner === 'tie' ? 'Tie' : g.winner + ' won') + '</span></div>';
      });
      html += '</div>';
    }
    scoreboardArea.innerHTML = html;
  }

  // =========================================================================
  //  GAME-SPECIFIC: Rendering
  // =========================================================================

  renderRound() {
    var roundLabel = document.getElementById('drawRoundLabel');
    if (roundLabel) roundLabel.textContent = 'Round ' + this.state.round + ' of ' + this.state.totalRounds;
    this.updateScoreDisplay();

    var gameArea       = document.getElementById('drawGameArea');
    var resultArea     = document.getElementById('drawResultArea');
    var summaryArea    = document.getElementById('drawSummaryArea');
    var scoreboardArea = document.getElementById('drawScoreboardArea');
    if (gameArea) gameArea.style.display         = 'flex';
    if (resultArea) resultArea.style.display     = 'none';
    if (summaryArea) summaryArea.style.display   = 'none';
    if (scoreboardArea) scoreboardArea.style.display = 'none';

    // Word display
    var wordDisplay = document.getElementById('drawWordDisplay');
    if (wordDisplay) {
      if (this.state.isDrawer) {
        wordDisplay.textContent = 'Draw: ' + (this.state.currentWord || '').toUpperCase();
        wordDisplay.style.letterSpacing = '2px';
      } else {
        var dashes = '';
        for (var i = 0; i < this.state.wordLength; i++) dashes += '_ ';
        wordDisplay.textContent = dashes.trim();
        wordDisplay.style.letterSpacing = '4px';
      }
    }

    // Role label
    var roleLabel = document.getElementById('drawRoleLabel');
    if (roleLabel) {
      roleLabel.textContent = this.state.isDrawer ? 'You are drawing!' : 'Guess the drawing!';
    }

    // Show/hide toolbar vs guess area
    var toolbar   = document.getElementById('drawToolbar');
    var guessArea = document.getElementById('drawGuessArea');
    if (toolbar) toolbar.style.display   = this.state.isDrawer ? 'flex' : 'none';
    if (guessArea) guessArea.style.display = this.state.isDrawer ? 'none' : 'flex';

    this.initCanvas();
    if (this.state.isDrawer) {
      this.renderToolbar();
      this.enableDrawing();
    } else {
      this.disableDrawing();
      this.setupGuessInput();
    }
    this.renderWrongGuesses();
    this._startRoundTimer();
  }

  renderRoundResult(data) {
    this.stopTimer();
    var gameArea   = document.getElementById('drawGameArea');
    var resultArea = document.getElementById('drawResultArea');
    if (gameArea) gameArea.style.display   = 'none';
    if (resultArea) resultArea.style.display = 'flex';

    var html = '<div class="draw-result-word">The word was: <strong>' + (data.word || '?').toUpperCase() + '</strong></div>';
    if (data.guessed) {
      html += '<div class="draw-result-info">' + (data.guesser || '?') + ' guessed correctly!</div>';
      html += '<div class="draw-result-scores">Guesser +' + (data.guesserScore || 0) + ' \u00B7 Drawer +' + (data.drawerScore || 0) + '</div>';
    } else {
      html += '<div class="draw-result-info">Nobody guessed the word!</div>';
    }
    if (this.state.round < this.state.totalRounds) {
      html += '<button id="drawNextBtn" class="game-btn" style="margin-top:16px" type="button">Next Round</button>';
    }
    resultArea.innerHTML = html;
    this.updateScoreDisplay();

    var self = this;
    var nextBtn = document.getElementById('drawNextBtn');
    if (nextBtn) {
      nextBtn.addEventListener('click', function() { self.nextRound(); });
    }
  }

  renderGameSummary(data) {
    var gameArea    = document.getElementById('drawGameArea');
    var resultArea  = document.getElementById('drawResultArea');
    var summaryArea = document.getElementById('drawSummaryArea');
    if (gameArea) gameArea.style.display     = 'none';
    if (resultArea) resultArea.style.display = 'none';
    if (summaryArea) summaryArea.style.display = 'block';

    var html = '<div class="draw-summary-title">';
    if (data.winner === 'tie') html += "It's a tie!";
    else if (data.winner === Messages.myRole) html += 'You win!';
    else html += data.winner + ' wins!';
    html += '</div><div class="draw-summary-scores">';
    html += '<div class="draw-summary-player' + (data.winner === 'E' ? ' winner' : '') + '">E: ' + data.totalScores.E + '</div>';
    html += '<div class="draw-summary-player' + (data.winner === 'M' ? ' winner' : '') + '">M: ' + data.totalScores.M + '</div>';
    html += '</div>';
    summaryArea.innerHTML = html;
  }

  updateScoreDisplay() {
    var el = document.getElementById('drawScoreDisplay');
    if (!el) return;
    el.innerHTML = '<span style="color:#ef4444;font-weight:600">E: ' + (this.state.scores.E || 0) + '</span><span style="color:var(--muted)"> \u2014 </span><span style="color:#3b82f6;font-weight:600">M: ' + (this.state.scores.M || 0) + '</span>';
  }

  renderWrongGuesses() {
    var container = document.getElementById('drawWrongGuesses');
    if (!container) return;
    container.innerHTML = '';
    this.state.wrongGuesses.forEach(function(g) {
      var span = document.createElement('span');
      span.className = 'draw-wrong-guess';
      span.textContent = g;
      container.appendChild(span);
    });
  }

  // =========================================================================
  //  GAME-SPECIFIC: Canvas
  // =========================================================================

  initCanvas() {
    this.canvas = document.getElementById('drawCanvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    var wrap = this.canvas.parentElement;
    if (wrap) {
      // Use the wrapper's actual rendered size (CSS: position absolute, inset 0)
      this.canvas.width  = wrap.offsetWidth;
      this.canvas.height = wrap.offsetHeight;
    }
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.lineCap  = 'round';
    this.ctx.lineJoin = 'round';
  }

  clearCanvas() {
    if (!this.ctx || !this.canvas) return;
    this.ctx.fillStyle = '#ffffff';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.state.allStrokes = [];
  }

  enableDrawing() {
    if (!this.canvas) return;
    var self = this;

    this.removeDrawHandlers();

    var getPos = function(e) {
      var rect = self.canvas.getBoundingClientRect();
      var x, y;
      if (e.touches) {
        x = e.touches[0].clientX - rect.left;
        y = e.touches[0].clientY - rect.top;
      } else {
        x = e.clientX - rect.left;
        y = e.clientY - rect.top;
      }
      return {x: x / self.canvas.width, y: y / self.canvas.height};
    };

    var startDraw = function(e) {
      if (self.state.phase !== 'drawing') return;
      e.preventDefault();
      self.state.isDrawing = true;
      var pos = getPos(e);
      self.ctx.beginPath();
      self.ctx.strokeStyle = self.state.currentColor;
      self.ctx.lineWidth   = self.state.brushSize;
      self.ctx.moveTo(pos.x * self.canvas.width, pos.y * self.canvas.height);
      self.state.strokeBuffer.push({type:'start', x:pos.x, y:pos.y, color:self.state.currentColor, size:self.state.brushSize});
      self.scheduleStrokeSend();
    };

    var moveDraw = function(e) {
      if (!self.state.isDrawing) return;
      e.preventDefault();
      var pos = getPos(e);
      self.ctx.lineTo(pos.x * self.canvas.width, pos.y * self.canvas.height);
      self.ctx.stroke();
      self.state.strokeBuffer.push({type:'move', x:pos.x, y:pos.y});
      self.scheduleStrokeSend();
    };

    var endDraw = function(e) {
      if (!self.state.isDrawing) return;
      self.state.isDrawing = false;
      self.state.strokeBuffer.push({type:'end'});
      self.flushStrokes();
    };

    this.canvas.addEventListener('mousedown', startDraw);
    this.canvas.addEventListener('mousemove', moveDraw);
    this.canvas.addEventListener('mouseup', endDraw);
    this.canvas.addEventListener('mouseleave', endDraw);
    this.canvas.addEventListener('touchstart', startDraw, {passive: false});
    this.canvas.addEventListener('touchmove', moveDraw, {passive: false});
    this.canvas.addEventListener('touchend', endDraw);
    this.canvas.addEventListener('touchcancel', endDraw);

    this._drawHandlers = {startDraw: startDraw, moveDraw: moveDraw, endDraw: endDraw};
    this.canvas.style.cursor = 'crosshair';
  }

  removeDrawHandlers() {
    if (!this.canvas || !this._drawHandlers) return;
    var h = this._drawHandlers;
    this.canvas.removeEventListener('mousedown', h.startDraw);
    this.canvas.removeEventListener('mousemove', h.moveDraw);
    this.canvas.removeEventListener('mouseup', h.endDraw);
    this.canvas.removeEventListener('mouseleave', h.endDraw);
    this.canvas.removeEventListener('touchstart', h.startDraw);
    this.canvas.removeEventListener('touchmove', h.moveDraw);
    this.canvas.removeEventListener('touchend', h.endDraw);
    this.canvas.removeEventListener('touchcancel', h.endDraw);
    this._drawHandlers = null;
  }

  disableDrawing() {
    if (!this.canvas) return;
    this.removeDrawHandlers();
    this.canvas.style.cursor = 'default';
  }

  scheduleStrokeSend() {
    if (this.state.strokeSendTimer) return;
    var self = this;
    this.state.strokeSendTimer = setTimeout(function() {
      self.flushStrokes();
    }, 50);
  }

  flushStrokes() {
    if (this.state.strokeSendTimer) {
      clearTimeout(this.state.strokeSendTimer);
      this.state.strokeSendTimer = null;
    }
    if (this.state.strokeBuffer.length === 0) return;
    var strokes = this.state.strokeBuffer.slice();
    this.state.strokeBuffer = [];
    if (this.state.isDrawer && this._wsReady()) {
      this._sendOp('draw_strokes', {gameId: this.state.gameId, strokes: strokes});
    }
  }

  replayStrokes(strokes) {
    if (!this.ctx || !this.canvas) return;
    var self = this;
    strokes.forEach(function(s) {
      if (s.type === 'start') {
        self.ctx.beginPath();
        self.ctx.strokeStyle = s.color || '#000000';
        self.ctx.lineWidth   = s.size || 4;
        self.ctx.moveTo(s.x * self.canvas.width, s.y * self.canvas.height);
      } else if (s.type === 'move') {
        self.ctx.lineTo(s.x * self.canvas.width, s.y * self.canvas.height);
        self.ctx.stroke();
      }
      // 'end' type: stroke ended, nothing to draw
    });
    self.state.allStrokes = self.state.allStrokes.concat(strokes);
  }

  // =========================================================================
  //  GAME-SPECIFIC: Toolbar
  // =========================================================================

  renderToolbar() {
    var toolbar = document.getElementById('drawToolbar');
    if (!toolbar) return;
    toolbar.innerHTML = '';
    var self = this;

    // Colors
    this.colors.forEach(function(color) {
      var btn = document.createElement('button');
      btn.className = 'draw-color' + (color === self.state.currentColor ? ' active' : '');
      btn.type = 'button';
      btn.style.background = color;
      if (color === '#ffffff') btn.style.border = '2px solid var(--border)';
      btn.addEventListener('click', function() {
        self.state.currentColor = color;
        self.renderToolbar();
      });
      toolbar.appendChild(btn);
    });

    // Brush sizes
    this.brushSizes.forEach(function(size) {
      var btn = document.createElement('button');
      btn.className = 'draw-brush-size' + (size === self.state.brushSize ? ' active' : '');
      btn.type = 'button';
      btn.textContent = size + 'px';
      btn.addEventListener('click', function() {
        self.state.brushSize = size;
        self.renderToolbar();
      });
      toolbar.appendChild(btn);
    });

    // Clear button
    var clearBtn = document.createElement('button');
    clearBtn.className = 'draw-clear-btn';
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    var gameRef = this;
    clearBtn.addEventListener('click', function() {
      gameRef.clearCanvas();
      if (gameRef._wsReady()) {
        gameRef._sendOp('draw_clear', {gameId: gameRef.state.gameId});
      }
    });
    toolbar.appendChild(clearBtn);
  }

  // =========================================================================
  //  GAME-SPECIFIC: Guess input
  // =========================================================================

  setupGuessInput() {
    var input = document.getElementById('drawGuessInput');
    var btn   = document.getElementById('drawGuessBtn');
    if (!input) return;
    input.value = '';
    input.disabled = false;
    input.focus();
    var self = this;

    input.onkeydown = function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        self.submitGuess();
      }
    };

    if (btn) {
      btn.onclick = function() { self.submitGuess(); };
    }
  }

  submitGuess() {
    var input = document.getElementById('drawGuessInput');
    if (!input) return;
    var guess = input.value.trim().toLowerCase();
    if (!guess) return;
    input.value = '';
    if (this.state.phase !== 'guessing') return;
    this._sendOp('draw_guess', {gameId: this.state.gameId, guess: guess});
    input.focus();
  }

  // =========================================================================
  //  GAME-SPECIFIC: Next round
  // =========================================================================

  nextRound() {
    this._sendOp('draw_next', {gameId: this.state.gameId});
  }

  // =========================================================================
  //  INTERNAL: Timer helper (uses base class startTimer)
  // =========================================================================

  _startRoundTimer() {
    var self = this;
    var timerEl = document.getElementById('drawTimer');
    this.startTimer(60,
      function onTick(s) {
        if (timerEl) {
          timerEl.textContent = self.getTimerDisplay(s);
          if (s <= 10) timerEl.classList.add('warning');
          else timerEl.classList.remove('warning');
        }
      },
      function onExpire() {
        // Server handles timeout
      }
    );
  }

})({
  prefix:        'draw',
  icon:          '\uD83C\uDFA8',
  title:         'Drawing Guess',
  subtitle:      '6 rounds \u00B7 60s each',
  modalId:       'drawModal',
  panelClass:    'draw-panel',
  showModal:     function() { UI.showDrawModal(); },
  hideModal:     function() { UI.hideDrawModal(); },
  scoreboardUrl: '/api/draw/scores/'
});
