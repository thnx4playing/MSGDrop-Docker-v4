// Path: html/js/videochat.js
// ============================================================================
// VIDEOCHAT.JS - FaceTime-style WebRTC video chat using PeerJS
// ============================================================================
// Call flow:
//   1. Caller clicks video btn → _ensurePeerReady() → startCall()
//      → sends 'incoming' WS signal with own peerId
//   2. Server broadcasts signal + fires SMS alert
//   3. Chat shows caller: "Calling..." | callee: incoming call card
//   4. Callee taps Answer → _answerCall() → sends 'answered' + own peerId
//   5. CALLER receives 'answered':
//      - Both in app → currentCall exists (ICE in progress) → do nothing
//      - Late-join   → currentCall is null (peer-unavailable cleared it) → re-call callee's peerId
//   6. Callee's peer.on('call') fires → answers → streams connect
//   7. Either side ends → 'ended' signal → chat shows "Call ended • 0:42"
//
// Peer ID broadcasting:
//   On every PeerJS 'open' event (init AND after reconnect), each client sends
//   op:'peer_ready' with their current peerId over WS. This ensures the remote
//   side always has the up-to-date peerId even after idle reconnects.
// ============================================================================

var VideoChat = {
  peer: null,
  currentCall: null,
  localStream: null,
  isInCall: false,
  myPeerId: null,
  dropId: null,
  myRole: null,

  // Tracks the other user's CURRENT peerId as broadcast via peer_ready signals.
  // Falls back to computed ID if we haven't received one yet.
  _remotePeerId: null,

  // DOM refs
  overlay: null,
  localVideo: null,
  remoteVideo: null,
  statusEl: null,
  endBtn: null,
  muteBtn: null,
  flipCamBtn: null,
  callBtn: null,

  // State
  isMuted: false,
  isFrontCam: true,
  _pendingCall: null,
  _callStartTime: null,
  _callMsgId: 'active-call',
  _waitInterval: null,

  init: function(dropId, role) {
    this.dropId = dropId;
    this.myRole = role;
    this.myPeerId = (dropId + '_' + role).replace(/[^a-zA-Z0-9_-]/g, '_');

    this.overlay    = document.getElementById('videoChatOverlay');
    this.localVideo = document.getElementById('localVideo');
    this.remoteVideo= document.getElementById('remoteVideo');
    this.statusEl   = document.getElementById('videoChatStatus');
    this.callingCard= document.getElementById('vcCallingCard');
    this.endBtn     = document.getElementById('videoEndBtn');
    this.muteBtn    = document.getElementById('videoMuteBtn');
    this.flipCamBtn = document.getElementById('videoFlipBtn');
    this.callBtn    = document.getElementById('videoCallBtn');

    this._setupButtons();
    this._initPeer();

    // Pre-warm camera/mic permissions.
    // ONLY run on browsers that actually support the permissions API
    // (Chrome/Edge/Firefox). Skip on Safari — permissions.query for
    // camera/mic throws on Safari, the pre-warm stops all tracks, and
    // iOS then re-prompts on every real getUserMedia call.
    setTimeout(function() { VideoChat._tryPreWarm(); }, 1500);
  },

  // ─── Permission pre-warm ─────────────────────────────────────────────────
  _tryPreWarm: function() {
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    if(!navigator.permissions || !navigator.permissions.query) {
      // permissions API not available (Safari) — skip pre-warm entirely.
      // Safari will prompt when the actual call starts; pre-warming here
      // doesn't prevent that and just triggers an extra permission dialog.
      console.log('[VideoChat] permissions API unavailable (Safari?), skipping pre-warm');
      return;
    }
    Promise.all([
      navigator.permissions.query({ name: 'camera' }).catch(function(){ return null; }),
      navigator.permissions.query({ name: 'microphone' }).catch(function(){ return null; })
    ]).then(function(results) {
      // If either query failed (Safari), skip pre-warm
      if(!results[0] || !results[1]) {
        console.log('[VideoChat] permissions.query unsupported, skipping pre-warm');
        return;
      }
      if(results[0].state !== 'granted' || results[1].state !== 'granted') {
        VideoChat._doMediaPreWarm();
      } else {
        console.log('[VideoChat] Camera/mic already granted, skipping pre-warm');
      }
    });
  },

  _doMediaPreWarm: function() {
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(function(stream) {
        stream.getTracks().forEach(function(t) { t.stop(); });
        console.log('[VideoChat] Camera/mic permissions pre-warmed');
      })
      .catch(function(err) {
        console.log('[VideoChat] Pre-warm denied or unavailable:', err.name);
      });
  },

  // ─── PeerJS init ─────────────────────────────────────────────────────────

  _initPeer: function() {
    var self = this;

    // Always destroy any existing peer before creating a new one
    if(self.peer && !self.peer.destroyed) {
      try { self.peer.destroy(); } catch(e) {}
    }

    self.peer = new Peer(self.myPeerId, {
      host: '0.peerjs.com',
      port: 443,
      path: '/',
      secure: true,
      debug: 0,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    });

    self.peer.on('open', function(id) {
      console.log('[VideoChat] PeerJS ready, ID:', id);
      self.myPeerId = id; // update in case it changed
      // Broadcast our current peerId to the remote side over WS.
      // This runs on initial connect AND after any reconnect, ensuring
      // the other user always has our latest peerId.
      if(typeof WebSocketManager !== 'undefined') {
        WebSocketManager.sendVideoSignal({
          op: 'peer_ready',
          from: self.myRole,
          peerId: id
        });
      }
    });

    self.peer.on('call', function(call) {
      console.log('[VideoChat] PeerJS call arrived from:', call.peer);
      self._pendingCall = call;
    });

    self.peer.on('error', function(err) {
      console.error('[VideoChat] PeerJS error:', err.type, err);
      if(err.type === 'peer-unavailable') {
        // Callee not yet on PeerJS. Null out currentCall so the
        // 'answered' handler knows to re-call when they show up.
        if(self.currentCall) {
          try { self.currentCall.close(); } catch(e) {}
          self.currentCall = null;
        }
        self._setStatus('Waiting for answer...');
      } else if(err.type === 'unavailable-id') {
        // ID conflict — append short suffix and retry.
        // We broadcast the new ID via peer 'open' handler above.
        self.myPeerId = self.myPeerId + '_' + Date.now().toString(36).slice(-4);
        console.warn('[VideoChat] ID taken, retrying with:', self.myPeerId);
        setTimeout(function() { self._initPeer(); }, 500);
      }
    });

    self.peer.on('disconnected', function() {
      console.log('[VideoChat] PeerJS disconnected, reconnecting...');
      if(!self.peer.destroyed) {
        // Small delay before reconnect — gives the network time to settle
        setTimeout(function() {
          if(self.peer && !self.peer.destroyed) self.peer.reconnect();
        }, 1000);
      }
    });

    self.peer.on('close', function() {
      console.log('[VideoChat] PeerJS peer closed');
    });
  },

  // ─── Ensure peer is connected before making a call ───────────────────────
  // Returns a Promise that resolves when the peer is open and ready.
  // Times out after 8 seconds and rejects.
  _ensurePeerReady: function() {
    var self = this;
    return new Promise(function(resolve, reject) {
      // Already open
      if(self.peer && !self.peer.disconnected && !self.peer.destroyed) {
        resolve();
        return;
      }
      // Destroyed — full re-init needed
      if(!self.peer || self.peer.destroyed) {
        console.log('[VideoChat] Peer destroyed, reinitializing...');
        self._initPeer();
      } else {
        // Disconnected — reconnect
        console.log('[VideoChat] Peer disconnected, reconnecting...');
        self.peer.reconnect();
      }
      // Wait for open event
      var timeout = setTimeout(function() {
        reject(new Error('PeerJS did not connect within 8s'));
      }, 8000);
      var onOpen = function() {
        clearTimeout(timeout);
        resolve();
      };
      self.peer.once('open', onOpen);
    });
  },

  // ─── Compute remote peer ID ───────────────────────────────────────────────
  // Uses the peer ID we received via peer_ready signal if available,
  // otherwise falls back to the deterministic computed ID.
  _getRemotePeerId: function() {
    if(this._remotePeerId) return this._remotePeerId;
    var otherRole = this.myRole === 'M' ? 'E' : 'M';
    return (this.dropId + '_' + otherRole).replace(/[^a-zA-Z0-9_-]/g, '_');
  },

  // ─── Start call (caller side) ────────────────────────────────────────────

  startCall: async function() {
    var self = this;
    if(self.isInCall) { self._showOverlay(); return; }

    // Make sure our peer is registered on PeerJS before we try to call
    try {
      await self._ensurePeerReady();
    } catch(err) {
      console.error('[VideoChat] Peer not ready:', err);
      self._showError('Connection unavailable. Please try again.');
      return;
    }

    try {
      self.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      self.localVideo.srcObject = self.localStream;
      self.localVideo.muted = true;
      self.localVideo.play().catch(function(e){ console.warn('[VideoChat] localVideo.play():', e); });

      self._showOverlay();
      self._setStatus('Calling...');
      self.isInCall = true;
      self._callStartTime = null;

      if(typeof Messages !== 'undefined' && Messages.injectCallMessage) {
        Messages.injectCallMessage({
          id: self._callMsgId,
          role: self.myRole,
          status: 'calling',
          isCaller: true
        });
      }

      if(typeof WebSocketManager !== 'undefined') {
        WebSocketManager.sendVideoSignal({
          op: 'incoming',
          from: self.myRole,
          peerId: self.myPeerId
        });
      }

      var remotePeerId = self._getRemotePeerId();
      console.log('[VideoChat] Calling peer:', remotePeerId);
      var call = self.peer.call(remotePeerId, self.localStream);
      self.currentCall = call;
      self._setupCallHandlers(call);

    } catch(err) {
      console.error('[VideoChat] getUserMedia error:', err);
      self.isInCall = false;
      self._hideOverlay();
      self._showMediaError(err);
    }
  },

  // ─── Answer call (callee side) ────────────────────────────────────────────

  _answerCall: async function() {
    var self = this;

    try {
      self.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      self.localVideo.srcObject = self.localStream;
      self.localVideo.muted = true;
      self.localVideo.play().catch(function(e){ console.warn('[VideoChat] localVideo.play():', e); });

      self._showOverlay();
      self._setStatus('Connecting...');
      self.isInCall = true;
      self._callStartTime = null;

      if(typeof Messages !== 'undefined' && Messages.updateCallMessage) {
        Messages.updateCallMessage(self._callMsgId, 'connecting');
      }

      // Include our peerId — the caller uses it to re-call us in the late-join case
      if(typeof WebSocketManager !== 'undefined') {
        WebSocketManager.sendVideoSignal({
          op: 'answered',
          from: self.myRole,
          peerId: self.myPeerId
        });
      }

      if(self._pendingCall) {
        // Both-in-app: PeerJS call already arrived, answer it immediately
        self._pendingCall.answer(self.localStream);
        self.currentCall = self._pendingCall;
        self._pendingCall = null;
        self._setupCallHandlers(self.currentCall);
      } else {
        // Late-join: caller will re-call us after receiving 'answered' signal
        self._waitForPeerCall();
      }

    } catch(err) {
      console.error('[VideoChat] _answerCall error:', err);
      self.isInCall = false;
      self._hideOverlay();
      self._showMediaError(err);
    }
  },

  _waitForPeerCall: function() {
    var self = this;
    var attempts = 0;
    if(self._waitInterval) clearInterval(self._waitInterval);
    self._waitInterval = setInterval(function() {
      attempts++;
      if(self._pendingCall) {
        clearInterval(self._waitInterval);
        self._waitInterval = null;
        self._pendingCall.answer(self.localStream);
        self.currentCall = self._pendingCall;
        self._pendingCall = null;
        self._setupCallHandlers(self.currentCall);
      } else if(attempts > 30) { // 15s timeout
        clearInterval(self._waitInterval);
        self._waitInterval = null;
        self._setStatus('Could not connect');
        setTimeout(function() { self._endCallInternal(true, 'disconnected'); }, 2000);
      }
    }, 500);
  },

  _declineCall: function() {
    if(this._pendingCall) { this._pendingCall.close(); this._pendingCall = null; }
    if(typeof Messages !== 'undefined' && Messages.updateCallMessage) {
      Messages.updateCallMessage(this._callMsgId, 'declined');
    }
    if(typeof WebSocketManager !== 'undefined') {
      WebSocketManager.sendVideoSignal({ op: 'declined', from: this.myRole });
    }
  },

  // ─── Call stream + lifecycle handlers ────────────────────────────────────

  _setupCallHandlers: function(call) {
    var self = this;

    call.on('stream', function(remoteStream) {
      console.log('[VideoChat] Remote stream received');
      self.remoteVideo.srcObject = remoteStream;
      self.remoteVideo.play().catch(function(e){ console.warn('[VideoChat] remoteVideo.play():', e); });
      self._setStatus('');
      self._callStartTime = Date.now();
      if(typeof Messages !== 'undefined' && Messages.updateCallMessage) {
        Messages.updateCallMessage(self._callMsgId, 'connected');
      }
    });

    call.on('close', function() {
      var wasConnected = !!self._callStartTime;
      self._endCallInternal(false, wasConnected ? 'ended' : 'disconnected');
    });

    call.on('error', function(err) {
      console.error('[VideoChat] Call error:', err);
      self._endCallInternal(false, 'disconnected');
    });
  },

  // ─── End call ─────────────────────────────────────────────────────────────

  _endCall: function(notify) {
    if(notify === undefined) notify = true;
    if(this._waitInterval) { clearInterval(this._waitInterval); this._waitInterval = null; }
    var wasConnected = !!this._callStartTime;
    this._endCallInternal(notify, wasConnected ? 'ended' : 'missed');
  },

  _endCallInternal: function(sendSignal, finalStatus) {
    if(this._waitInterval) { clearInterval(this._waitInterval); this._waitInterval = null; }
    var duration = 0;
    if(this._callStartTime) {
      duration = Math.round((Date.now() - this._callStartTime) / 1000);
    }
    this._callStartTime = null;

    if(this.currentCall) {
      try { this.currentCall.close(); } catch(e) {}
      this.currentCall = null;
    }
    if(this.localStream) {
      this.localStream.getTracks().forEach(function(t) { t.stop(); });
      this.localStream = null;
    }
    if(this.localVideo)  { this.localVideo.srcObject  = null; }
    if(this.remoteVideo) { this.remoteVideo.srcObject = null; }

    this.isInCall = false;
    this.isMuted  = false;
    this._hideOverlay();

    if(typeof Messages !== 'undefined' && Messages.updateCallMessage) {
      Messages.updateCallMessage(this._callMsgId, finalStatus, duration);
    }
    if(sendSignal && typeof WebSocketManager !== 'undefined') {
      WebSocketManager.sendVideoSignal({
        op: 'ended',
        from: this.myRole,
        duration: duration,
        reason: finalStatus
      });
    }
  },

  // ─── Handle incoming WS video signals ────────────────────────────────────

  handleSignal: function(payload) {
    var op   = payload.op;
    var from = payload.from;
    var self = this;

    if(op === 'peer_ready') {
      // Remote side just connected/reconnected to PeerJS.
      // Cache their current peerId so we use the right ID when calling.
      if(from && from !== self.myRole && payload.peerId) {
        self._remotePeerId = payload.peerId;
        console.log('[VideoChat] Remote peer ID updated:', payload.peerId, 'for', from);
      }
      return;
    }

    if(op === 'incoming') {
      // Cache the caller's peerId from the signal
      if(payload.peerId && from !== self.myRole) {
        self._remotePeerId = payload.peerId;
      }
      if(!this.isInCall) {
        if(typeof Messages !== 'undefined' && Messages.injectCallMessage) {
          Messages.injectCallMessage({
            id: self._callMsgId,
            role: from,
            status: 'incoming',
            isCaller: false
          });
        }
      }

    } else if(op === 'answered') {
      this._setStatus('Connecting...');
      if(typeof Messages !== 'undefined' && Messages.updateCallMessage) {
        Messages.updateCallMessage(this._callMsgId, 'connecting');
      }

      // Cache callee's peerId
      if(payload.peerId) self._remotePeerId = payload.peerId;

      // Late-join fix: only re-call if our original peer.call() failed
      // (peer-unavailable nulled currentCall). If currentCall exists, ICE
      // negotiation is already in progress — don't interfere.
      var calleePeerId = payload.peerId || self._getRemotePeerId();
      if(calleePeerId && self.localStream && !self.currentCall) {
        console.log('[VideoChat] Late-join: re-calling callee at peerId:', calleePeerId);
        var newCall = self.peer.call(calleePeerId, self.localStream);
        self.currentCall = newCall;
        self._setupCallHandlers(newCall);
      }

    } else if(op === 'declined') {
      if(typeof Messages !== 'undefined' && Messages.updateCallMessage) {
        Messages.updateCallMessage(this._callMsgId, 'declined');
      }
      setTimeout(function() { self._endCallInternal(false, 'declined'); }, 1500);

    } else if(op === 'ended') {
      var duration = payload.duration || 0;
      var reason   = payload.reason   || 'ended';
      if(this.isInCall) {
        this._endCallInternal(false, reason);
      } else {
        if(typeof Messages !== 'undefined' && Messages.updateCallMessage) {
          Messages.updateCallMessage(this._callMsgId, reason, duration);
        }
      }
    }
  },

  // ─── Mute / flip ──────────────────────────────────────────────────────────

  toggleMute: function() {
    if(!this.localStream) return;
    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach(function(t) { t.enabled = !VideoChat.isMuted; });
    if(this.muteBtn) {
      this.muteBtn.classList.toggle('active', this.isMuted);
      this.muteBtn.setAttribute('aria-label', this.isMuted ? 'Unmute' : 'Mute');
      this.muteBtn.querySelector('.vc-icon').innerHTML = this.isMuted ? ICONS.micOff : ICONS.micOn;
    }
  },

  flipCamera: async function() {
    if(!this.localStream || !this.currentCall) return;
    var self = this;
    self.isFrontCam = !self.isFrontCam;
    try {
      var newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: self.isFrontCam ? 'user' : 'environment' },
        audio: true
      });
      var newVideoTrack = newStream.getVideoTracks()[0];
      var sender = self.currentCall.peerConnection.getSenders().find(function(s) {
        return s.track && s.track.kind === 'video';
      });
      if(sender) sender.replaceTrack(newVideoTrack);
      var oldVideo = self.localStream.getVideoTracks()[0];
      if(oldVideo) oldVideo.stop();
      self.localStream.removeTrack(oldVideo);
      self.localStream.addTrack(newVideoTrack);
      self.localVideo.srcObject = self.localStream;
      self.localVideo.play().catch(function(){});
    } catch(err) {
      console.error('[VideoChat] Flip camera error:', err);
    }
  },

  // ─── UI helpers ───────────────────────────────────────────────────────────

  _showOverlay: function() {
    if(this.overlay) this.overlay.classList.add('show');
    document.body.classList.add('no-scroll');
  },

  _hideOverlay: function() {
    if(this.overlay) this.overlay.classList.remove('show');
    document.body.classList.remove('no-scroll');
  },

  _setStatus: function(text) {
    if(!this.statusEl) return;
    var isCalling = (text === 'Calling...' || text === 'Waiting for answer...');
    // Show calling card for calling/waiting states, plain text for others
    if(this.callingCard) {
      if(isCalling) {
        var subEl = this.callingCard.querySelector('.vc-calling-sub');
        if(subEl) subEl.textContent = text;
        this.callingCard.style.display = 'flex';
        this.statusEl.style.display = 'none';
      } else {
        this.callingCard.style.display = 'none';
        this.statusEl.textContent = text;
        this.statusEl.style.display = text ? 'block' : 'none';
      }
    } else {
      this.statusEl.textContent = text;
      this.statusEl.style.display = text ? 'block' : 'none';
    }
  },

  _showError: function(msg) {
    var toast = document.createElement('div');
    toast.className = 'upload-toast error';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function() { toast.classList.add('show'); }, 10);
    setTimeout(function() { toast.classList.remove('show'); setTimeout(function() { toast.remove(); }, 300); }, 4000);
  },

  _showMediaError: function(err) {
    var msg = 'Camera/mic unavailable';
    if(err && err.name === 'NotAllowedError') msg = 'Camera/mic permission denied. Please allow access in your browser settings.';
    if(err && err.name === 'NotFoundError')   msg = 'No camera/mic found';
    this._showError(msg);
  },

  _setupButtons: function() {
    var self = this;
    if(self.endBtn)     self.endBtn.addEventListener('click', function() { self._endCall(true); });
    if(self.muteBtn)    self.muteBtn.addEventListener('click', function() { self.toggleMute(); });
    if(self.flipCamBtn) self.flipCamBtn.addEventListener('click', function() { self.flipCamera(); });
    if(self.callBtn)    self.callBtn.addEventListener('click', function() { self.startCall(); });
  }
};

// SVG icons for mute toggle
var ICONS = {
  micOn:  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
};
