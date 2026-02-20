// Path: html/js/websocket.js
// ============================================================================
// WEBSOCKET.JS - v4: video_signal + auto-reconnect after idle drop
// ============================================================================

var WebSocketManager = {
  ws: null,
  dropId: null,
  userLabel: null,
  lastTypingSent: 0,
  typingState: new Map(),
  typingTimeouts: new Map(),
  onUpdateCallback: null,
  onTypingCallback: null,
  onGameCallback: null,
  onGameListCallback: null,
  onStreakCallback: null,
  onVideoSignalCallback: null,
  presenceState: new Map(),
  presenceTimeouts: new Map(),
  heartbeatInterval: null,

  // ── Reconnect state ──────────────────────────────────────────────────────
  _reconnectTimer: null,
  _reconnectAttempts: 0,
  _maxReconnectDelay: 30000,
  _intentionalClose: false,   // set true before auth-redirect so we don't reconnect

  getCookie: function(name) {
    var matches = document.cookie.match(new RegExp(
      '(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)'
    ));
    return matches ? decodeURIComponent(matches[1]) : null;
  },

  connect: function(dropId, userLabel){
    if(!CONFIG.USE_WS) return;
    this.dropId = dropId;
    this.userLabel = userLabel;
    this._intentionalClose = false;
    this._doConnect();
  },

  _doConnect: function(){
    var sessionToken = this.getCookie('session-ok');
    if(!sessionToken || sessionToken === 'true') {
      console.error('[WS] No valid session token, redirecting to unlock');
      this._redirectToUnlock();
      return;
    }
    var url = CONFIG.WS_URL
      + '?sessionToken=' + encodeURIComponent(sessionToken)
      + '&dropId='       + encodeURIComponent(this.dropId)
      + '&user='         + encodeURIComponent(this.userLabel);
    try {
      this.ws = new WebSocket(url);
      this.ws.onopen    = this._onOpen.bind(this);
      this.ws.onmessage = this._onMessage.bind(this);
      this.ws.onclose   = this._onClose.bind(this);
      this.ws.onerror   = this._onError.bind(this);
    } catch(e){ console.error('[WS] Init failed:', e); }
  },

  _onOpen: function(){
    console.log('[WS] Connected');
    this._reconnectAttempts = 0;
    if(this._reconnectTimer){ clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if(UI.setLive) UI.setLive('Connected (Live)');
    this.updatePresence(this.userLabel, true);
    if(this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.heartbeatInterval = setInterval(this.sendHeartbeat.bind(this), 30000);
    this.sendHeartbeat();
    setTimeout(this.requestPresence.bind(this), 500);
    setTimeout(function(){ WebSocketManager.requestGameList(); }, 200);
    setTimeout(function(){
      if(typeof Messages !== 'undefined' && Messages.sendReadReceipts) Messages.sendReadReceipts();
    }, 100);
    // Re-broadcast our PeerJS ID so the other side updates their cached remote peer ID
    // (important after reconnect in case PeerJS re-initialized with a new ID)
    setTimeout(function(){
      if(typeof VideoChat !== 'undefined' && VideoChat.myPeerId && VideoChat.peer && !VideoChat.peer.destroyed) {
        WebSocketManager.sendVideoSignal({ op: 'peer_ready', peerId: VideoChat.myPeerId, from: WebSocketManager.userLabel });
      }
    }, 800);
  },

  _onMessage: function(ev){
    try {
      var msg = JSON.parse(ev.data || '{}');
      if(msg.type === 'update'){
        if(msg.data){ if(this.onUpdateCallback) this.onUpdateCallback(msg.data); }
        else {
          if(this.onUpdateCallback && typeof API !== 'undefined'){
            API.fetchDrop(this.dropId).then(function(data){
              if(this.onUpdateCallback) this.onUpdateCallback(data);
            }.bind(this)).catch(function(e){ console.error('[WS] Failed to fetch drop:', e); });
          }
        }
      } else if(msg.type === 'typing' && msg.payload){
        if(this.onTypingCallback) this.onTypingCallback(msg.payload);
      } else if(msg.type === 'presence' && msg.data){
        this.handlePresence(msg.data);
      } else if(msg.type === 'presence_request'){
        this.sendHeartbeat();
      } else if(msg.type === 'game' && msg.payload){
        if(this.onGameCallback) this.onGameCallback(msg.payload);
      } else if(msg.type === 'game_list' && msg.data){
        if(this.onGameListCallback) this.onGameListCallback(msg.data);
      } else if(msg.type === 'streak' && msg.data){
        if(this.onStreakCallback) this.onStreakCallback(msg.data);
      } else if(msg.type === 'delivery_receipt' && msg.data){
        if(typeof Messages !== 'undefined' && Messages.handleDeliveryReceipt) Messages.handleDeliveryReceipt(msg.data);
      } else if(msg.type === 'read_receipt' && msg.data){
        if(typeof Messages !== 'undefined' && Messages.handleReadReceipt) Messages.handleReadReceipt(msg.data);
      } else if(msg.type === 'video_signal' && msg.payload){
        if(this.onVideoSignalCallback) this.onVideoSignalCallback(msg.payload);
        if(typeof VideoChat !== 'undefined' && VideoChat.handleSignal) VideoChat.handleSignal(msg.payload);
      } else if(msg.type === 'error'){
        console.error('[WS] Server error:', msg.message);
      }
    } catch(e){ console.error('[WS] Parse error:', e); }
  },

  _onClose: function(event){
    if(UI.setLive) UI.setLive('Connected (Polling)');
    if(this.heartbeatInterval){ clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }

    // Auth failure → clean up call and redirect; do not reconnect
    if(event.code === 1008) {
      var sessionToken = this.getCookie('session-ok');
      if(!sessionToken || sessionToken === 'true'){
        this._cleanupCallOnSessionExpiry();
        this._redirectToUnlock();
        return;
      }
    }

    // Intentional close (e.g. user navigating away) → do not reconnect
    if(this._intentionalClose) return;

    // Unexpected drop → reconnect with exponential backoff
    this._scheduleReconnect();
  },

  _onError: function(e){
    console.error('[WS] Connection error:', e);
    // Auth check - if no valid session, redirect
    var sessionToken = this.getCookie('session-ok');
    if(!sessionToken || sessionToken === 'true'){
      this._cleanupCallOnSessionExpiry();
      this._redirectToUnlock();
    }
    // onclose will fire after onerror, which will schedule reconnect
  },

  _scheduleReconnect: function(){
    if(this._reconnectTimer) return; // already scheduled
    this._reconnectAttempts++;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
    var delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), this._maxReconnectDelay);
    console.log('[WS] Reconnecting in', delay + 'ms (attempt', this._reconnectAttempts + ')');
    this._reconnectTimer = setTimeout(function(){
      WebSocketManager._reconnectTimer = null;
      WebSocketManager._doConnect();
    }, delay);
  },

  _cleanupCallOnSessionExpiry: function(){
    if(typeof VideoChat === 'undefined') return;
    if(VideoChat.isInCall) {
      VideoChat._endCallInternal(false, 'ended');
    } else if(VideoChat._pendingCall) {
      try { VideoChat._pendingCall.close(); } catch(e) {}
      VideoChat._pendingCall = null;
    }
    var callCard = document.getElementById('call-sys-' + VideoChat._callMsgId);
    if(callCard) callCard.remove();
  },

  _redirectToUnlock: function(){
    this._intentionalClose = true;
    var returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = '/unlock/?next=' + returnUrl;
  },

  // ── Send helpers ─────────────────────────────────────────────────────────

  sendTyping: function(){
    if(!this.ws || this.ws.readyState !== 1) return;
    var now = Date.now();
    if(now - this.lastTypingSent < 1200) return;
    this.lastTypingSent = now;
    try { this.ws.send(JSON.stringify({ action: 'typing', payload: { state: 'start', ts: now } })); }
    catch(e){ console.error('[WS] Send typing failed:', e); }
  },

  sendReadReceipt: function(upToSeq, reader){
    if(!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify({ action: 'read', payload: { upToSeq: upToSeq, reader: reader } }));
      return true;
    } catch(e){ console.error('[WS] Send read receipt failed:', e); return false; }
  },

  sendVideoSignal: function(payload){
    if(!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify({ action: 'video_signal', type: 'video_signal', payload: payload }));
      return true;
    } catch(e){ console.error('[WS] Send video signal failed:', e); return false; }
  },

  sendGameAction: function(payload){
    if(!this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(JSON.stringify({ action: 'game', type: 'game', payload: payload })); }
    catch(e){ console.error('[WS] Failed to send game action:', e); }
  },

  requestGameList: function(){ this.sendGameAction({ op: 'request_game_list' }); },
  startGame:       function(gt, gd){ this.sendGameAction({ op: 'start', gameType: gt, gameData: gd }); },
  joinGame:        function(id){ this.sendGameAction({ op: 'join_game', gameId: id }); },
  sendMove:        function(id, md){ this.sendGameAction({ op: 'move', gameId: id, moveData: md }); },
  endGame:         function(id, r){ this.sendGameAction({ op: 'end_game', gameId: id, result: r }); },

  sendHeartbeat: function(){
    if(!this.ws || this.ws.readyState !== 1) return;
    try {
      this.ws.send(JSON.stringify({ action: 'presence', payload: { user: this.userLabel, state: 'active', ts: Date.now() } }));
    } catch(e){ console.error('[WS] Send heartbeat failed:', e); }
  },

  sendMessage: function(text, user, clientId, replyToSeq){
    if(!this.ws || this.ws.readyState !== 1) return false;
    try {
      var payload = { text: text, user: user, clientId: clientId };
      if(replyToSeq) payload.replyToSeq = replyToSeq;
      this.ws.send(JSON.stringify({ action: 'chat', payload: payload }));
      return true;
    } catch(e){ console.error('[WS] Send message failed:', e); return false; }
  },

  sendGIF: function(gifData, user, clientId){
    if(!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify({ action: 'gif', payload: {
        gifUrl: gifData.fullUrl, gifPreview: gifData.previewUrl,
        gifWidth: gifData.width, gifHeight: gifData.height,
        title: gifData.title, user: user, clientId: clientId
      }}));
      return true;
    } catch(e){ console.error('[WS] Send GIF failed:', e); return false; }
  },

  requestPresence: function(){
    if(!this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(JSON.stringify({ action: 'presence_request', payload: { ts: Date.now() } })); }
    catch(e){ console.error('[WS] Request presence failed:', e); }
  },

  handlePresence: function(data){
    var user = data.user, state = data.state, ts = data.ts || Date.now();
    if(!user) return;
    if(this.presenceTimeouts.has(user)){ clearTimeout(this.presenceTimeouts.get(user)); this.presenceTimeouts.delete(user); }
    this.presenceState.set(user, { state: state, ts: ts });
    this.updatePresence(user, state === 'active');
    if(state === 'active'){
      var timeout = setTimeout(function(){
        this.updatePresence(user, false);
        this.presenceTimeouts.delete(user);
      }.bind(this), 60000);
      this.presenceTimeouts.set(user, timeout);
    }
  },

  updatePresence: function(role, isActive){
    if(UI && UI.updatePresence) UI.updatePresence(role, isActive);
  },

  disconnect: function(){
    this._intentionalClose = true;
    if(this._reconnectTimer){ clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if(this.heartbeatInterval){ clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
    if(this.ws){ try { this.ws.close(); } catch(e){} this.ws = null; }
  }
};
