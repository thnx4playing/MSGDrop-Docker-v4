// Path: html/js/websocket.js
// ============================================================================
// WEBSOCKET.JS - v4: Added video_signal handling
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
    var sessionToken = this.getCookie('session-ok');
    if(!sessionToken) {
      console.error('[WS] No session token found');
      var returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = '/unlock/?next=' + returnUrl;
      return;
    }
    if(sessionToken === 'true') {
      console.error('[WS] session-ok has old format');
      var returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = '/unlock/?next=' + returnUrl;
      return;
    }
    var url = CONFIG.WS_URL 
      + '?sessionToken=' + encodeURIComponent(sessionToken)
      + '&dropId=' + encodeURIComponent(dropId) 
      + '&user=' + encodeURIComponent(userLabel);
    try {
      this.ws = new WebSocket(url);
      this.ws.onopen = function(){
        if(UI.setLive) UI.setLive('Connected (Live)');
        this.updatePresence(this.userLabel, true);
        if(this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = setInterval(function(){
          this.sendHeartbeat();
        }.bind(this), 30000);
        this.sendHeartbeat();
        setTimeout(function(){ this.requestPresence(); }.bind(this), 500);
        setTimeout(function(){ WebSocketManager.requestGameList(); }, 200);
        setTimeout(function(){
          if(typeof Messages !== 'undefined' && Messages.sendReadReceipts) Messages.sendReadReceipts();
        }, 100);
      }.bind(this);

      this.ws.onmessage = function(ev){
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
          } else if(msg.type === 'presence_request' && msg.data){
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
            // Also route to VideoChat directly if available
            if(typeof VideoChat !== 'undefined' && VideoChat.handleSignal) VideoChat.handleSignal(msg.payload);
          } else if(msg.type === 'error'){
            console.error('[WS] Server error:', msg.message);
          }
        } catch(e){ console.error('[WS] Parse error:', e); }
      }.bind(this);

      this.ws.onclose = function(event){
        if(UI.setLive) UI.setLive('Connected (Polling)');
        if(this.heartbeatInterval){ clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
        if(event.code === 1008 || event.code === 1006){
          var sessionToken = this.getCookie('session-ok');
          if(!sessionToken || sessionToken === 'true'){
            // ── Clean up any active or pending video call before navigating away ──
            // The WS is already closed so we can't send signals, but we still need to:
            //   1. Stop camera/mic tracks (removes browser camera indicator)
            //   2. Close the PeerJS call (PeerJS uses its own connection to 0.peerjs.com,
            //      so the remote side gets a call.on('close') event even after our WS dies)
            //   3. Remove the call UI so it doesn't linger on the unlock screen
            if(typeof VideoChat !== 'undefined') {
              if(VideoChat.isInCall) {
                // Don't send WS signal (false) — WS is closed. PeerJS handles remote cleanup.
                VideoChat._endCallInternal(false, 'ended');
              } else if(VideoChat._pendingCall) {
                // Unanswered incoming call — close the PeerJS side
                try { VideoChat._pendingCall.close(); } catch(e) {}
                VideoChat._pendingCall = null;
              }
              // Remove lingering call UI card (incoming or calling state)
              var callCard = document.getElementById('call-sys-' + VideoChat._callMsgId);
              if(callCard) callCard.remove();
            }

            var returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = '/unlock/?next=' + returnUrl;
          }
        }
      }.bind(this);

      this.ws.onerror = function(e){
        console.error('[WS] Connection error:', e);
        var sessionToken = this.getCookie('session-ok');
        if(!sessionToken || sessionToken === 'true'){
          var returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
          window.location.href = '/unlock/?next=' + returnUrl;
        }
      }.bind(this);
    } catch(e){ console.error('[WS] Init failed:', e); }
  },

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
  startGame: function(gameType, gameData){ this.sendGameAction({ op: 'start', gameType: gameType, gameData: gameData }); },
  joinGame: function(gameId){ this.sendGameAction({ op: 'join_game', gameId: gameId }); },
  sendMove: function(gameId, moveData){ this.sendGameAction({ op: 'move', gameId: gameId, moveData: moveData }); },
  endGame: function(gameId, result){ this.sendGameAction({ op: 'end_game', gameId: gameId, result: result }); },

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
    if(this.heartbeatInterval){ clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
    if(this.ws){ try { this.ws.close(); } catch(e){} this.ws = null; }
  }
};
