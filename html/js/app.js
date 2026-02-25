// Path: html/js/app.js
// ============================================================================
// APP.JS - v4: Added audio recording + video call wiring
// ============================================================================

var App = {
  dropId: '',
  pollTimer: null,
  myClientId: null,
  myRole: null,

  init: function(){
    Storage.requireAuth();
    if(typeof CookieChecker !== 'undefined') CookieChecker.init();
    try {
      this.dropId = new URL(window.location.href).searchParams.get('drop') || 'default';
    } catch (e) { this.dropId = 'default'; }

    this.myClientId = Storage.getClientId();
    this.myRole = Storage.getRole(this.dropId);
    Messages.myRole = this.myRole;

    UI.init();
    this.initGiphy();
    if(typeof Camera !== 'undefined') Camera.init();

    // Init audio recorder
    if(typeof Audio !== 'undefined') Audio.init();

    this.setupEventListeners();
    Reactions.setup();
    this.setupEmoji();
    this.startCountdownTimer();
    this.loadInitialData();
    this.startSessionChecks();
  },

  initGiphy: function(){
    var self = this;
    if(typeof GiphyPicker === 'undefined'){ console.warn('GiphyPicker not loaded'); return; }
    this.giphyPicker = new GiphyPicker('mrWcrFYs1lvhwbxxNNM3hmb9hUkFfbk4');
    console.log('✓ GIPHY picker initialized');
  },

  startSessionChecks: function(){
    var self = this;
    setInterval(async function(){
      try{
        var url = CONFIG.API_BASE_URL.replace(/\/$/,'') + '/chat/' + encodeURIComponent(self.dropId);
        var res = await fetch(url, { method:'HEAD', credentials:'include' });
        if(res.status === 401 || res.status === 403){
          var nextUrl = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = '/unlock/?next=' + nextUrl;
        }
      }catch(e){}
    }, 60000);
  },

  loadInitialData: async function(){
    try {
      var data = await API.fetchDrop(this.dropId);
      Messages.applyDrop(data);
      if(data.images){
        Images.list = data.images.map(function(im){
          return { id: im.imageId, urls: { thumb: im.thumbUrl, original: im.originalUrl }, uploadedAt: im.uploadedAt };
        });
        Images.render();
      }
      if(typeof Streak !== 'undefined'){
        Streak.fetch(this.dropId).catch(function(e){ console.log('Streak fetch failed:', e); });
      }

      WebSocketManager.onUpdateCallback = function(data){ Messages.applyDrop(data); };
      WebSocketManager.onTypingCallback = function(data){ Messages.handleTyping(data); };
      WebSocketManager.onGameCallback = function(data){
        if(data && data.op && data.op.indexOf('geo_') === 0){
          if(typeof GeoGame !== 'undefined') GeoGame.applyOp(data.op, data);
        } else if(data && data.op && data.op.indexOf('wordle_') === 0){
          if(typeof WordleGame !== 'undefined') WordleGame.applyOp(data.op, data);
        } else if(data && data.op && data.op.indexOf('trivia_') === 0){
          if(typeof TriviaGame !== 'undefined') TriviaGame.applyOp(data.op, data);
        } else if(data && data.op && data.op.indexOf('draw_') === 0){
          if(typeof DrawingGame !== 'undefined') DrawingGame.applyOp(data.op, data);
        } else {
          Game.applyGame(data);
        }
      };
      WebSocketManager.onGameListCallback = function(data){ Game.handleGameList(data); };
      WebSocketManager.onStreakCallback = function(data){ if(typeof Streak !== 'undefined') Streak.handleWebSocketUpdate(data); };
      WebSocketManager.onQACallback = function(data){ if(typeof QA !== 'undefined') QA.applyMessage(data); };
      // VideoChat signal callback handled directly in websocket.js

      WebSocketManager.connect(this.dropId, this.myRole);

      // Init video chat after WS connects (needs dropId + role)
      if(typeof VideoChat !== 'undefined'){
        VideoChat.init(this.dropId, this.myRole);
      }

      if(CONFIG.USE_POLL) this.startPolling();
      UI.setLive('Connected');

    } catch(e){
      console.error('Failed to load initial data:', e);
      if(e.message !== 'AUTH_REQUIRED') UI.setLive('Error loading data');
    }
  },

  setupEventListeners: function(){
    var self = this;

    // File upload
    if(UI.els.fileInput){
      UI.els.fileInput.addEventListener('change', function(e){
        var file = (e.target.files && e.target.files[0]); 
        e.target.value = '';
        if(!file) return;
        Images.upload(file);
      });
    }
    if(UI.els.uploadBtn){
      UI.els.uploadBtn.addEventListener('click', function(){ if(UI.els.fileInput) UI.els.fileInput.click(); });
    }

    // GIF button
    var gifButton = document.getElementById('gif-button');
    if(gifButton && this.giphyPicker){
      gifButton.addEventListener('click', function(){
        self.giphyPicker.show(function(gifData){ self.sendGifMessage(gifData); });
      });
    }

    // Camera button
    var cameraBtn = document.getElementById('cameraBtn');
    if(cameraBtn && typeof Camera !== 'undefined'){
      cameraBtn.addEventListener('click', function(){ Camera.show(); });
    }

    // Logout/lock button (in header)
    var logoutBtn = document.getElementById('logoutBtn');
    if(logoutBtn){
      logoutBtn.addEventListener('click', async function(){
        try {
          await fetch(CONFIG.API_BASE_URL.replace(/\/$/, '') + '/logout', {
            method: 'POST', credentials: 'include'
          });
        } catch(e){}
        var nextUrl = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = '/unlock/?next=' + nextUrl;
      });
    }

    // Video call button (in header)
    var videoCallBtn = document.getElementById('videoCallBtn');
    if(videoCallBtn && typeof VideoChat !== 'undefined'){
      videoCallBtn.addEventListener('click', function(){ VideoChat.startCall(); });
    }

    // Library
    if(UI.els.libraryBtn){
      UI.els.libraryBtn.addEventListener('click', async function(){
        await Images.fetch(self.dropId, true);
        UI.showThumbModal();
      });
    }
    if(UI.els.thumbCloseBtn){
      UI.els.thumbCloseBtn.addEventListener('click', function(){ UI.hideThumbModal(); });
    }
    if(UI.els.thumbOverlay){
      UI.els.thumbOverlay.addEventListener('click', function(e){ UI.hideThumbModal(); });
    }

    // User role
    if(UI.els.userBtn){ UI.els.userBtn.addEventListener('click', function(){ UI.showUserRoleModal(); }); }
    if(UI.els.roleE){ UI.els.roleE.addEventListener('click', function(){ self.selectUserRole('E'); }); }
    if(UI.els.roleM){ UI.els.roleM.addEventListener('click', function(){ self.selectUserRole('M'); }); }
    if(UI.els.userRoleModal){
      UI.els.userRoleModal.addEventListener('click', function(e){
        if(e.target === UI.els.userRoleModal) UI.hideUserRoleModal();
      });
    }

    // Post / edit message
    if(UI.els.postBtn){
      UI.els.postBtn.addEventListener('click', function(e){
        e.preventDefault();
        if(Messages.editingSeq !== null) self.editMessage();
        else self.postMessage();
      });
    }
    if(UI.els.cancelEditBtn){
      UI.els.cancelEditBtn.addEventListener('click', function(e){ e.preventDefault(); Messages.exitEditMode(); });
    }
    var cancelReplyBtn = document.getElementById('cancelReplyBtn');
    if(cancelReplyBtn){
      cancelReplyBtn.addEventListener('click', function(e){ e.preventDefault(); Messages.exitReplyMode(); });
    }

    // Lightbox
    if(UI.els.lbCloseCenter){ UI.els.lbCloseCenter.addEventListener('click', function(){ UI.hideLightbox(); }); }
    if(UI.els.lightbox){ UI.els.lightbox.addEventListener('click', function(e){ if(e.target === UI.els.lightbox) UI.hideLightbox(); }); }

    // Theme toggle
    if(UI.els.themeToggle){ UI.els.themeToggle.addEventListener('click', function(){ Storage.toggleTheme(); }); }

    // Typing handler
    if(UI.els.reply){
      UI.els.reply.addEventListener('input', function(){
        WebSocketManager.sendTyping();
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 100) + 'px';
      });
    }

    // Games — launcher menu buttons
    var ticTacToeBtn2 = document.getElementById('ticTacToeBtn2');
    if(ticTacToeBtn2){ ticTacToeBtn2.addEventListener('click', function(){ Game.startNewGame(); }); }
    if(UI.els.ticTacToeBtn){ UI.els.ticTacToeBtn.addEventListener('click', function(){ Game.startNewGame(); }); }
    var gamesPopoverClose = document.getElementById('gamesPopoverClose');
    if(gamesPopoverClose){ gamesPopoverClose.addEventListener('click', function(){ UI.hideGamesMenu(); }); }
    if(UI.els.gameCloseBtn){ UI.els.gameCloseBtn.addEventListener('click', function(){ Game.closeGame(); }); }
    var gameCloseBtn2 = document.getElementById('gameCloseBtn2');
    if(gameCloseBtn2){ gameCloseBtn2.addEventListener('click', function(){ Game.closeGame(); }); }
    if(UI.els.gameEndBtn){ UI.els.gameEndBtn.addEventListener('click', function(){ Game.endGame(); }); }
    if(UI.els.gamesPopover){
      UI.els.gamesPopover.addEventListener('click', function(e){ if(e.target === UI.els.gamesPopover) UI.hideGamesMenu(); });
    }

    // GeoGuessr — launcher menu button, toolbar shortcut, and games popover button
    var geoGuessrBtn = document.getElementById('geoGuessrBtn');
    if(geoGuessrBtn && typeof GeoGame !== 'undefined'){
      geoGuessrBtn.addEventListener('click', function(){ GeoGame.startNewGame(); });
    }
    var geoGuessrBtn2 = document.getElementById('geoGuessrBtn2');
    if(geoGuessrBtn2 && typeof GeoGame !== 'undefined'){
      geoGuessrBtn2.addEventListener('click', function(){ GeoGame.startNewGame(); });
    }
    var geoShortcutBtn = document.getElementById('geoShortcutBtn');
    if(geoShortcutBtn && typeof GeoGame !== 'undefined'){
      geoShortcutBtn.addEventListener('click', function(){ GeoGame.startNewGame(); });
    }
    var geoCloseBtn = document.getElementById('geoCloseBtn');
    if(geoCloseBtn){ geoCloseBtn.addEventListener('click', function(){ if(typeof GeoGame !== 'undefined') GeoGame.closeGame(); }); }
    var geoCloseGameBtn = document.getElementById('geoCloseGameBtn');
    if(geoCloseGameBtn){ geoCloseGameBtn.addEventListener('click', function(){ if(typeof GeoGame !== 'undefined') GeoGame.closeGame(); }); }
    var geoSubmitBtn = document.getElementById('geoSubmitBtn');
    if(geoSubmitBtn){ geoSubmitBtn.addEventListener('click', function(){ if(typeof GeoGame !== 'undefined') GeoGame.submitGuess(); }); }
    var geoNextBtn = document.getElementById('geoNextBtn');
    if(geoNextBtn){ geoNextBtn.addEventListener('click', function(){ if(typeof GeoGame !== 'undefined') GeoGame.nextRound(); }); }
    var geoScoreboardBtn = document.getElementById('geoScoreboardBtn');
    if(geoScoreboardBtn){ geoScoreboardBtn.addEventListener('click', function(){ if(typeof GeoGame !== 'undefined') GeoGame.showScoreboard(); }); }
    var geoViewToggle = document.getElementById('geoViewToggle');
    if(geoViewToggle){ geoViewToggle.addEventListener('click', function(){ if(typeof GeoGame !== 'undefined') GeoGame.toggleMobileView(); }); }

    // Wordle Battle — launcher menu + popover
    var wordleBtn = document.getElementById('wordleBtn');
    if(wordleBtn && typeof WordleGame !== 'undefined'){
      wordleBtn.addEventListener('click', function(){ WordleGame.startNewGame(); });
    }
    var wordleBtn2 = document.getElementById('wordleBtn2');
    if(wordleBtn2 && typeof WordleGame !== 'undefined'){
      wordleBtn2.addEventListener('click', function(){ WordleGame.startNewGame(); });
    }
    var wordleCloseBtn = document.getElementById('wordleCloseBtn');
    if(wordleCloseBtn){ wordleCloseBtn.addEventListener('click', function(){ if(typeof WordleGame !== 'undefined') WordleGame.closeGame(); }); }
    var wordleCloseGameBtn = document.getElementById('wordleCloseGameBtn');
    if(wordleCloseGameBtn){ wordleCloseGameBtn.addEventListener('click', function(){ if(typeof WordleGame !== 'undefined') WordleGame.closeGame(); }); }
    var wordleScoreboardBtn = document.getElementById('wordleScoreboardBtn');
    if(wordleScoreboardBtn){ wordleScoreboardBtn.addEventListener('click', function(){ if(typeof WordleGame !== 'undefined') WordleGame.showScoreboard(); }); }

    // Trivia Duel — launcher menu + popover
    var triviaBtn = document.getElementById('triviaBtn');
    if(triviaBtn && typeof TriviaGame !== 'undefined'){
      triviaBtn.addEventListener('click', function(){ TriviaGame.startNewGame(); });
    }
    var triviaBtn2 = document.getElementById('triviaBtn2');
    if(triviaBtn2 && typeof TriviaGame !== 'undefined'){
      triviaBtn2.addEventListener('click', function(){ TriviaGame.startNewGame(); });
    }
    var triviaCloseBtn = document.getElementById('triviaCloseBtn');
    if(triviaCloseBtn){ triviaCloseBtn.addEventListener('click', function(){ if(typeof TriviaGame !== 'undefined') TriviaGame.closeGame(); }); }
    var triviaCloseGameBtn = document.getElementById('triviaCloseGameBtn');
    if(triviaCloseGameBtn){ triviaCloseGameBtn.addEventListener('click', function(){ if(typeof TriviaGame !== 'undefined') TriviaGame.closeGame(); }); }
    var triviaScoreboardBtn = document.getElementById('triviaScoreboardBtn');
    if(triviaScoreboardBtn){ triviaScoreboardBtn.addEventListener('click', function(){ if(typeof TriviaGame !== 'undefined') TriviaGame.showScoreboard(); }); }
    var triviaNextBtn = document.getElementById('triviaNextBtn');
    if(triviaNextBtn){ triviaNextBtn.addEventListener('click', function(){ if(typeof TriviaGame !== 'undefined') TriviaGame.nextQuestion(); }); }

    // Drawing Guess — launcher menu + popover
    var drawBtn = document.getElementById('drawBtn');
    if(drawBtn && typeof DrawingGame !== 'undefined'){
      drawBtn.addEventListener('click', function(){ DrawingGame.startNewGame(); });
    }
    var drawBtn2 = document.getElementById('drawBtn2');
    if(drawBtn2 && typeof DrawingGame !== 'undefined'){
      drawBtn2.addEventListener('click', function(){ DrawingGame.startNewGame(); });
    }
    var drawCloseBtn = document.getElementById('drawCloseBtn');
    if(drawCloseBtn){ drawCloseBtn.addEventListener('click', function(){ if(typeof DrawingGame !== 'undefined') DrawingGame.closeGame(); }); }
    var drawCloseGameBtn = document.getElementById('drawCloseGameBtn');
    if(drawCloseGameBtn){ drawCloseGameBtn.addEventListener('click', function(){ if(typeof DrawingGame !== 'undefined') DrawingGame.closeGame(); }); }
    var drawScoreboardBtn = document.getElementById('drawScoreboardBtn');
    if(drawScoreboardBtn){ drawScoreboardBtn.addEventListener('click', function(){ if(typeof DrawingGame !== 'undefined') DrawingGame.showScoreboard(); }); }
    var drawClearBtn = document.getElementById('drawClearBtn');
    if(drawClearBtn){ drawClearBtn.addEventListener('click', function(){ if(typeof DrawingGame !== 'undefined') DrawingGame.clearCanvas(); }); }
    var drawGuessBtn = document.getElementById('drawGuessBtn');
    if(drawGuessBtn){ drawGuessBtn.addEventListener('click', function(){ if(typeof DrawingGame !== 'undefined') DrawingGame.submitGuess(); }); }

    // Q&A
    var qaBtn = document.getElementById('qaBtn');
    if(qaBtn){ qaBtn.addEventListener('click', function(){ if(typeof QA !== 'undefined') QA.openModal(); }); }
    var qaCloseBtn = document.getElementById('qaCloseBtn');
    if(qaCloseBtn){ qaCloseBtn.addEventListener('click', function(){ UI.hideQAModal(); }); }
    var qaModal = document.getElementById('qaModal');
    if(qaModal){ qaModal.addEventListener('click', function(e){ if(e.target === qaModal) UI.hideQAModal(); }); }

    // Game board
    var gameCells = document.querySelectorAll('.game-cell');
    gameCells.forEach(function(cell){
      cell.addEventListener('click', function(){
        var r = parseInt(this.getAttribute('data-row'), 10);
        var c = parseInt(this.getAttribute('data-col'), 10);
        if(!isNaN(r) && !isNaN(c)) Game.makeMove(r, c);
      });
    });

    // Escape key
    window.addEventListener('keydown', function(e){
      if(e.key === 'Escape'){
        UI.hideGamesMenu();
        UI.hideLightbox();
        UI.hideThumbModal();
        Reactions.closePicker();
        UI.hideUserRoleModal();
        Messages.exitReplyMode();
        if(self.giphyPicker && self.giphyPicker.modal && self.giphyPicker.modal.style.display === 'flex') self.giphyPicker.hide();
        if(typeof Camera !== 'undefined' && Camera.isOpen) Camera.hide();
        UI.hideQAModal();
        UI.hideWordleModal();
        UI.hideTriviaModal();
        UI.hideDrawModal();
        // Don't close active video call with Escape
      }
    });
  },

  setupEmoji: function(){
    if(!UI.els.emojiBtn || !UI.els.emojiPopover || !UI.els.emojiGrid) return;
    UI.els.emojiGrid.innerHTML = '';
    var curated = ["😀","😂","🥲","🙂","🙄","🤔","🤢","🤤","😣","😫","😴","🥶","😈","💩","🤡"];
    var frag = document.createDocumentFragment();
    curated.forEach(function(emoji){
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = emoji; b.className = 'emoji-btn'; b.setAttribute('aria-label', emoji);
      b.addEventListener('click', function(){
        UI.insertAtCursor(UI.els.reply, emoji);
        UI.els.emojiPopover.style.display = 'none';
      });
      frag.appendChild(b);
    });
    UI.els.emojiGrid.appendChild(frag);
    UI.els.emojiBtn.onclick = function(){
      UI.els.emojiPopover.style.display = (UI.els.emojiPopover.style.display === 'block' ? 'none' : 'block');
    };
    document.addEventListener('click', function(ev){
      if(!UI.els.emojiPopover || !UI.els.emojiBtn) return;
      if(ev.target === UI.els.emojiBtn || UI.els.emojiBtn.contains(ev.target) || UI.els.emojiPopover.contains(ev.target)) return;
      UI.els.emojiPopover.style.display = 'none';
    });
  },

  startPolling: function(){
    if(!CONFIG.USE_POLL) return;
    if(this.pollTimer) clearInterval(this.pollTimer);
    var self = this;
    this.pollTimer = setInterval(async function(){
      try{
        var data = await API.fetchDrop(self.dropId);
        Messages.applyDrop(data);
        if(data.images){
          Images.list = data.images.map(function(im){
            return { id: im.imageId, urls: { thumb: im.thumbUrl, original: im.originalUrl }, uploadedAt: im.uploadedAt };
          });
          Images.render();
        }
      }catch(e){ console.error('Poll error:', e); }
    }, CONFIG.POLL_MS);
  },

  _countdownInterval: null,

  startCountdownTimer: function(){
    if(!UI.els.composeTimer) return;
    // Clear any previous interval to prevent stacking
    if(this._countdownInterval) clearInterval(this._countdownInterval);
    // Read real expiry from the session-ok token cookie
    var expiry = 0;
    try {
      var token = Storage.getCookie('session-ok');
      if(token){
        // Token is base64url: {"exp":TIMESTAMP}.HMAC — decode just the JSON prefix
        var b64 = token.replace(/-/g, '+').replace(/_/g, '/');
        // Add correct padding (0-2 chars based on length)
        var pad = (4 - b64.length % 4) % 4;
        for(var i = 0; i < pad; i++) b64 += '=';
        var raw = atob(b64);
        // Find the JSON object boundary in the decoded string
        var brace = raw.indexOf('}');
        if(brace > 0){
          var payload = JSON.parse(raw.substring(0, brace + 1));
          if(payload.exp) expiry = payload.exp;
        }
      }
    } catch(e){ console.warn('[Timer] Failed to parse session token:', e); }
    if(!expiry){
      console.warn('[Timer] Could not read expiry from cookie');
      UI.els.composeTimer.textContent = '--';
      return;
    }
    function fmt(s){
      if(s >= 60) return Math.floor(s / 60) + 'm';
      return s + 's';
    }
    function remaining(){ return Math.max(0, expiry - Math.floor(Date.now() / 1000)); }
    UI.els.composeTimer.textContent = fmt(remaining());
    this._countdownInterval = setInterval(function(){
      var secs = remaining();
      if(UI.els.composeTimer) UI.els.composeTimer.textContent = fmt(secs);
      if(UI.els.composeTimer){
        if(secs < 10) UI.els.composeTimer.classList.add('warning');
        else UI.els.composeTimer.classList.remove('warning');
      }
    }, 1000);
  },

  selectUserRole: function(role){
    Storage.setRole(this.dropId, role);
    this.myRole = role;
    Messages.myRole = role;
    this.updateRoleSelection();
    UI.hideUserRoleModal();
    if(WebSocketManager.ws){
      WebSocketManager.ws.close();
      setTimeout(function(){
        WebSocketManager.connect(this.dropId, this.myRole);
        // Re-init VideoChat with new role
        if(typeof VideoChat !== 'undefined') VideoChat.init(this.dropId, this.myRole);
      }.bind(this), 100);
    }
    Messages.render();
  },

  updateRoleSelection: function(){
    if(!UI.els.roleE || !UI.els.roleM) return;
    UI.els.roleE.classList.remove('selected');
    UI.els.roleM.classList.remove('selected');
    if(this.myRole === 'E') UI.els.roleE.classList.add('selected');
    else if(this.myRole === 'M') UI.els.roleM.classList.add('selected');
  },

  sendGifMessage: function(gifData){
    if(WebSocketManager.ws && WebSocketManager.ws.readyState === 1){
      var sent = WebSocketManager.sendGIF(gifData, this.myRole, this.myClientId);
      if(sent) return;
    }
    var payload = { gifUrl: gifData.fullUrl, gifPreview: gifData.previewUrl, gifWidth: gifData.width, gifHeight: gifData.height, title: gifData.title, user: this.myRole };
    fetch(CONFIG.API_BASE_URL + '/chat/' + this.dropId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(payload) })
    .then(function(res){ if(!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function(data){ Messages.applyDrop(data); })
    .catch(function(e){ console.error('Failed to send GIF:', e); alert('Failed to send GIF. Please try again.'); });
  },

  postMessage: async function(){
    if(!UI.els.reply) return;
    var text = (UI.els.reply.value||"").trim();
    if(!text) return;
    if(UI.els.postBtn && UI.els.postBtn.disabled) return;
    if(UI.els.postBtn) UI.els.postBtn.disabled = true;
    var replyToSeq = Messages.replyingToSeq;
    try{
      if(WebSocketManager.ws && WebSocketManager.ws.readyState === 1){
        var sent = WebSocketManager.sendMessage(text, this.myRole, this.myClientId, replyToSeq);
        if(sent){
          UI.els.reply.value = '';
          UI.els.reply.style.height = 'auto';
          Messages.exitReplyMode();
          setTimeout(function(){ if(UI.els.postBtn) UI.els.postBtn.disabled = false; }, 500);
          return;
        }
      }
      var res = await API.postMessage(this.dropId, text, Messages.currentVersion, this.myRole, this.myClientId, replyToSeq);
      if(!res.ok){
        if(res.status === 409){ var data = await API.fetchDrop(this.dropId); Messages.applyDrop(data); alert('Message was updated. Please try again.'); }
        return;
      }
      var data = await res.json();
      Messages.applyDrop(data);
      UI.els.reply.value = '';
      UI.els.reply.style.height = 'auto';
      Messages.exitReplyMode();
    }catch(e){ console.error('Post error:', e); }
    finally{ setTimeout(function(){ if(UI.els.postBtn) UI.els.postBtn.disabled = false; }, 500); }
  },

  editMessage: async function(){
    if(!UI.els.reply || Messages.editingSeq === null) return;
    var text = (UI.els.reply.value||"").trim();
    if(!text) return;
    if(UI.els.postBtn && UI.els.postBtn.disabled) return;
    if(UI.els.postBtn) UI.els.postBtn.disabled = true;
    try{
      var res = await API.editMessage(this.dropId, Messages.editingSeq, text);
      if(!res.ok){ alert('Failed to edit message: ' + res.status); return; }
      var data = await res.json();
      Messages.applyDrop(data);
      Messages.exitEditMode();
    }catch(e){ console.error('Edit error:', e); }
    finally{ setTimeout(function(){ if(UI.els.postBtn) UI.els.postBtn.disabled = false; }, 500); }
  },

  deleteMessage: async function(seq){
    try{
      var res = await API.deleteMessage(this.dropId, seq);
      if(!res.ok){ alert('Delete failed: HTTP ' + res.status); var data = await API.fetchDrop(this.dropId); Messages.applyDrop(data); return; }
      var data = await res.json();
      Messages.applyDrop(data);
    }catch(e){ console.error('Delete error:', e); alert('Network error while deleting.'); }
  }
};

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', function(){ App.init(); });
} else {
  App.init();
}
