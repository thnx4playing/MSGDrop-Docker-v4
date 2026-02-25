// Path: html/js/game-engine.js
// ============================================================================
// GAME-ENGINE.JS - Shared base class for all MSGDrop v4 multiplayer games
// ============================================================================
//
// Extracts duplicated invite lifecycle, timer, pause overlay, scoreboard,
// forfeit, and op-routing logic that every game (GeoGuessr, Wordle, Trivia,
// Drawing) currently copy-pastes.
//
// Usage:
//   var myGame = new GameEngine({
//     prefix:        'wordle',
//     icon:          '\uD83D\uDCDD',
//     title:         'Wordle Battle',
//     subtitle:      '5 rounds \u00b7 2 min each',
//     modalId:       'wordleModal',
//     panelClass:    'wordle-panel',
//     showModal:     function() { UI.showWordleModal(); },
//     hideModal:     function() { UI.hideWordleModal(); },
//     scoreboardUrl: '/api/wordle/scores/'
//   });
//
// Then override handleResume(), handleGameOp(), renderGame(), and any
// game-specific hooks.
// ============================================================================

window.GameEngine = class GameEngine {

  // ─── Constructor ──────────────────────────────────────────────────────────

  /**
   * @param {Object} config
   * @param {string} config.prefix        - Op prefix, e.g. "geo", "wordle", "trivia", "draw"
   * @param {string} config.icon          - Emoji icon for invite/pause cards
   * @param {string} config.title         - Human-readable game name
   * @param {string} [config.subtitle]    - Subtitle for invite card (e.g. "5 rounds \u00b7 60s each")
   * @param {string} config.modalId       - DOM id of the game modal element
   * @param {string} config.panelClass    - CSS class of the inner panel (for pause overlay)
   * @param {Function} config.showModal   - Function to show the game modal
   * @param {Function} config.hideModal   - Function to hide the game modal
   * @param {string} [config.scoreboardUrl] - API path prefix for scores, e.g. "/api/geo/scores/"
   * @param {string[]} [config.activePhases] - Phases considered "in-game" for forfeit on close
   */
  constructor(config) {
    this.prefix       = config.prefix;
    this.icon         = config.icon;
    this.title        = config.title;
    this.subtitle     = config.subtitle || '';
    this.modalId      = config.modalId;
    this.panelClass   = config.panelClass;
    this.showModal    = config.showModal;
    this.hideModal    = config.hideModal;
    this.scoreboardUrl = config.scoreboardUrl || null;

    // Phases where closing the modal should trigger a forfeit confirmation.
    // Subclasses may override via config or by setting this after construction.
    this.activePhases = config.activePhases || ['guessing', 'waiting', 'result', 'roundResult',
      'paused', 'playing', 'answering', 'questionResult', 'drawing'];

    // ── Core state (shared across all games) ──
    this.state = {
      phase:     'idle',
      gameId:    null,
      inviteId:  null,
      invitedBy: null
    };

    // ── Timer ──
    this.timerInterval = null;
    this.timerSeconds  = 0;
  }

  // =========================================================================
  //  INVITE LIFECYCLE
  // =========================================================================

  /**
   * Send a new game invite over the WebSocket.
   * Mirrors the pattern: check role + WS readiness, send {prefix}_invite, hide launcher.
   */
  startNewGame() {
    if (!Messages.myRole) {
      alert('Please select your role first');
      return;
    }
    if (!WebSocketManager.ws || WebSocketManager.ws.readyState !== 1) {
      alert('Not connected to server');
      return;
    }
    this._sendOp(this.prefix + '_invite');
    UI.hideGamesMenu();
  }

  /**
   * Accept a pending invite.
   */
  acceptInvite() {
    if (!this._wsReady()) return;
    this._sendOp(this.prefix + '_invite_accepted', {
      inviteId: this.state.inviteId
    });
  }

  /**
   * Decline a pending invite.
   */
  declineInvite() {
    if (!this._wsReady()) return;
    this._sendOp(this.prefix + '_invite_declined', {
      inviteId: this.state.inviteId
    });
  }

  /**
   * Cancel a pending invite that we sent.
   */
  cancelInvite() {
    if (!this._wsReady()) return;
    this._sendOp(this.prefix + '_invite_cancelled', {
      inviteId: this.state.inviteId
    });
  }

  // ─── Incoming invite handlers ──────────────────────────────────────────

  /**
   * Process an incoming {prefix}_invite op.
   * Injects the invite card into the chat via Messages.injectGameInvite().
   */
  handleInvite(data) {
    var fromPlayer = data.from;
    this.state.inviteId = data.inviteId;
    this.state.invitedBy = fromPlayer;

    var self = this;
    var isMine = (fromPlayer === Messages.myRole);

    if (typeof Messages !== 'undefined' && Messages.injectGameInvite) {
      Messages.injectGameInvite({
        id:       data.inviteId,
        role:     fromPlayer,
        status:   isMine ? 'waiting' : 'incoming',
        game:     this.prefix,
        icon:     this.icon,
        title:    this.title,
        subtitle: this.subtitle,
        onAccept:  function() { self.acceptInvite(); },
        onDecline: function() { self.declineInvite(); },
        onCancel:  function() { self.cancelInvite(); }
      });
    }
  }

  /**
   * The invite was accepted — update the invite card to "starting".
   * Called when we receive the game-started op (not invite_accepted directly),
   * since the server collapses accept into started.  However, if the server
   * sends an explicit invite_accepted op, this handler is available.
   */
  handleInviteAccepted(data) {
    if (typeof Messages !== 'undefined' && Messages.updateGameInvite) {
      Messages.updateGameInvite(this.prefix, this.state.inviteId, 'starting', this.icon);
    }
    this.state.inviteId = null;
  }

  /**
   * The invite was declined — update the card and reset invite state.
   */
  handleInviteDeclined(data) {
    if (typeof Messages !== 'undefined' && Messages.updateGameInvite) {
      Messages.updateGameInvite(this.prefix, this.state.inviteId, 'declined', this.icon);
    }
    this.state.inviteId = null;
  }

  /**
   * The invite was cancelled — update the card and reset invite state.
   */
  handleInviteCancelled(data) {
    if (typeof Messages !== 'undefined' && Messages.updateGameInvite) {
      Messages.updateGameInvite(this.prefix, this.state.inviteId, 'cancelled', this.icon);
    }
    this.state.inviteId = null;
  }

  /**
   * Helper: clear the invite card when the game starts.
   * Called by subclasses from their "started" handler.
   */
  clearInviteCard() {
    if (this.state.inviteId && typeof Messages !== 'undefined' && Messages.updateGameInvite) {
      Messages.updateGameInvite(this.prefix, this.state.inviteId, 'starting', this.icon);
    }
    this.state.inviteId = null;
  }

  // =========================================================================
  //  TIMER
  // =========================================================================

  /**
   * Start a countdown timer.
   *
   * @param {number}   seconds   - Total seconds to count down from.
   * @param {Function} onTick    - Called every second with (remainingSeconds).
   *                               Use this to update the timer DOM element.
   * @param {Function} onExpire  - Called when the timer reaches 0.
   */
  startTimer(seconds, onTick, onExpire) {
    this.stopTimer();
    this.timerSeconds = seconds;

    // Fire initial tick so UI shows full time immediately
    if (onTick) onTick(this.timerSeconds);

    var self = this;
    this.timerInterval = setInterval(function() {
      self.timerSeconds--;
      if (onTick) onTick(self.timerSeconds);
      if (self.timerSeconds <= 0) {
        self.stopTimer();
        if (onExpire) onExpire();
      }
    }, 1000);
  }

  /**
   * Stop (clear) the running timer.
   */
  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  /**
   * Format the current timerSeconds as "M:SS".
   *
   * @param {number} [seconds] - Optional override; defaults to this.timerSeconds.
   * @returns {string} e.g. "1:05", "0:09"
   */
  getTimerDisplay(seconds) {
    var s = (seconds !== undefined) ? seconds : this.timerSeconds;
    if (s < 0) s = 0;
    var min = Math.floor(s / 60);
    var sec = s % 60;
    return min + ':' + (sec < 10 ? '0' : '') + sec;
  }

  // =========================================================================
  //  PAUSE / RESUME OVERLAY
  // =========================================================================

  /**
   * Handle the other player disconnecting during a game.
   * Pauses the game, stops the timer, injects a pause card into chat,
   * and renders a pause overlay inside the game modal.
   */
  handlePlayerDisconnected(data) {
    if (data.player === Messages.myRole) return;  // ignore our own disconnect echo
    if (!this.state.gameId) return;

    this.state.phase = 'paused';
    this.stopTimer();

    var self = this;
    if (typeof Messages !== 'undefined' && Messages.injectGamePauseCard) {
      Messages.injectGamePauseCard({
        gameId:    data.gameId,
        player:    data.player,
        game:      this.prefix,
        icon:      this.icon,
        title:     this.title,
        onEndGame: function() {
          if (self.state.gameId) {
            self._sendOp(self.prefix + '_forfeit', { gameId: self.state.gameId });
            self.resetState();
            self.removePauseOverlay();
            self.hideModal();
          }
        }
      });
    }

    this.renderPauseOverlay(data.player);
  }

  /**
   * Handle the other player reconnecting during a paused game.
   * Removes the pause overlay and chat card.
   * NOTE: The subclass should restore the correct phase and restart its timer
   * after calling super.handlePlayerReconnected(data).
   */
  handlePlayerReconnected(data) {
    if (data.player === Messages.myRole) return;
    if (!this.state.gameId) return;

    if (typeof Messages !== 'undefined' && Messages.removeGamePauseCard) {
      Messages.removeGamePauseCard(this.prefix, data.gameId, this.icon);
    }
    this.removePauseOverlay();
  }

  /**
   * Render a translucent pause overlay inside the game modal panel.
   *
   * @param {string} player - The player who disconnected (e.g. "E" or "M").
   */
  renderPauseOverlay(player) {
    this.removePauseOverlay();
    var panel = document.querySelector('.' + this.panelClass);
    if (!panel) return;

    var overlay = document.createElement('div');
    overlay.className = 'game-pause-overlay';
    overlay.innerHTML =
      '<div class="game-pause-content">' +
        '<div class="game-pause-title">Game Paused</div>' +
        '<div class="game-pause-sub">' + player + ' disconnected</div>' +
        '<div class="game-pause-hint">Waiting for them to return\u2026</div>' +
      '</div>';
    panel.appendChild(overlay);
  }

  /**
   * Remove the pause overlay from the game modal.
   */
  removePauseOverlay() {
    var overlay = document.querySelector('.game-pause-overlay');
    if (overlay) overlay.remove();
  }

  // =========================================================================
  //  FORFEIT
  // =========================================================================

  /**
   * Handle an incoming forfeit op from the other player.
   */
  handleForfeit(data) {
    if (data.player !== Messages.myRole) {
      this.state.phase = 'summary';
      this.stopTimer();
      // Subclass should override renderForfeitMessage() for custom UI
      this.renderForfeitMessage();
    }
  }

  /**
   * Send a forfeit op and end the game locally.
   */
  forfeit() {
    if (this.state.gameId && this._wsReady()) {
      this._sendOp(this.prefix + '_forfeit', { gameId: this.state.gameId });
    }
  }

  /**
   * Default forfeit message renderer.
   * Subclasses should override to render into their specific summary area.
   */
  renderForfeitMessage() {
    // Default no-op; subclasses render their own forfeit UI
  }

  // =========================================================================
  //  SCOREBOARD
  // =========================================================================

  /**
   * Fetch and render the scoreboard for this game.
   * Uses this.scoreboardUrl + dropId to fetch scores from the API.
   *
   * @param {string} [dropId] - Drop ID; defaults to App.dropId.
   */
  showScoreboard(dropId) {
    if (!this.scoreboardUrl) return;
    var id = dropId || App.dropId;
    var self = this;

    fetch(this.scoreboardUrl + encodeURIComponent(id), { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) { self.renderScoreboard(data); })
      .catch(function(e) { console.error('[' + self.prefix + '] Failed to load scores:', e); });
  }

  /**
   * Render the scoreboard data.
   * Subclasses should override this for game-specific scoreboard HTML.
   *
   * @param {Object} data - Scoreboard response from the API.
   */
  renderScoreboard(data) {
    // Default no-op; subclasses render their own scoreboard UI
  }

  // =========================================================================
  //  CLOSE / RESET
  // =========================================================================

  /**
   * Close the game modal. If the game is in an active phase, prompt the
   * user and forfeit if they confirm.
   */
  closeGame() {
    if (this.activePhases.indexOf(this.state.phase) !== -1) {
      if (!confirm('Leave the game? This will forfeit.')) return;
      this.forfeit();
    }
    this.removePauseOverlay();
    this.resetState();
    this.hideModal();
  }

  /**
   * Reset shared state back to idle. Subclasses should call super.resetState()
   * and then reset their own game-specific state.
   */
  resetState() {
    this.stopTimer();
    if (typeof Messages !== 'undefined' && Messages.removeGameInviteCards) {
      Messages.removeGameInviteCards(this.prefix);
    }
    this.state.phase     = 'idle';
    this.state.gameId    = null;
    this.state.inviteId  = null;
    this.state.invitedBy = null;
  }

  // =========================================================================
  //  OP ROUTING
  // =========================================================================

  /**
   * Route an incoming WebSocket game op to the correct handler.
   * Called from the master onGameCallback in app.js.
   *
   * Standard ops handled here:
   *   {prefix}_invite               -> handleInvite(data)
   *   {prefix}_invite_accepted      -> handleInviteAccepted(data)
   *   {prefix}_invite_declined      -> handleInviteDeclined(data)
   *   {prefix}_invite_cancelled     -> handleInviteCancelled(data)
   *   {prefix}_player_disconnected  -> handlePlayerDisconnected(data)
   *   {prefix}_player_reconnected   -> handlePlayerReconnected(data)
   *   {prefix}_forfeit              -> handleForfeit(data)
   *   {prefix}_resume               -> handleResume(data)  [subclass]
   *   anything else                 -> handleGameOp(op, data) [subclass]
   *
   * @param {string} op   - The full op string, e.g. "wordle_invite"
   * @param {Object} data - The payload data from the WebSocket message
   */
  applyOp(op, data) {
    if (!op) return;

    var p = this.prefix + '_';

    if (op === p + 'invite') {
      this.handleInvite(data);
      return;
    }
    if (op === p + 'invite_accepted') {
      this.handleInviteAccepted(data);
      return;
    }
    if (op === p + 'invite_declined') {
      this.handleInviteDeclined(data);
      return;
    }
    if (op === p + 'invite_cancelled') {
      this.handleInviteCancelled(data);
      return;
    }
    if (op === p + 'player_disconnected') {
      this.handlePlayerDisconnected(data);
      return;
    }
    if (op === p + 'player_reconnected') {
      this.handlePlayerReconnected(data);
      return;
    }
    if (op === p + 'forfeit') {
      this.handleForfeit(data);
      return;
    }
    if (op === p + 'resume') {
      this.handleResume(data);
      return;
    }

    // Everything else is game-specific
    this.handleGameOp(op, data);
  }

  // =========================================================================
  //  ABSTRACT METHODS (subclass must override)
  // =========================================================================

  /**
   * Handle a resume op — rebuild the game UI from a server snapshot after
   * the player reconnects.
   *
   * @param {Object} data - Server snapshot of the current game state.
   */
  handleResume(data) {
    console.warn('[GameEngine:' + this.prefix + '] handleResume() not implemented');
  }

  /**
   * Handle a game-specific op that is not part of the shared lifecycle
   * (e.g. geo_started, wordle_guess_result, trivia_question_result, etc.).
   *
   * @param {string} op   - The full op string.
   * @param {Object} data - The payload data.
   */
  handleGameOp(op, data) {
    console.warn('[GameEngine:' + this.prefix + '] handleGameOp(' + op + ') not implemented');
  }

  /**
   * Render the game UI. Called after game state changes that require a
   * full re-render (e.g. new round, resume).
   */
  renderGame() {
    console.warn('[GameEngine:' + this.prefix + '] renderGame() not implemented');
  }

  // =========================================================================
  //  INTERNAL HELPERS
  // =========================================================================

  /**
   * Check if the WebSocket is open and ready to send.
   * @returns {boolean}
   */
  _wsReady() {
    return WebSocketManager.ws && WebSocketManager.ws.readyState === 1;
  }

  /**
   * Send a game op over the WebSocket.
   * Mirrors the pattern used by all four games:
   *   WebSocketManager.ws.send(JSON.stringify({ action: 'game', payload: {...} }))
   *
   * @param {string} op              - The op string, e.g. "wordle_invite"
   * @param {Object} [extraPayload]  - Additional fields merged into the payload.
   */
  _sendOp(op, extraPayload) {
    if (!this._wsReady()) return;
    var payload = { op: op };
    if (extraPayload) {
      for (var key in extraPayload) {
        if (extraPayload.hasOwnProperty(key)) {
          payload[key] = extraPayload[key];
        }
      }
    }
    WebSocketManager.ws.send(JSON.stringify({
      action: 'game',
      payload: payload
    }));
  }
};
