// Path: html/js/videochat.js
// ============================================================================
// VIDEOCHAT.JS - FaceTime-style WebRTC video chat using PeerJS
// ============================================================================
// Call flow:
//   1. Caller clicks video btn → startCall() → sends 'incoming' WS signal
//   2. Server broadcasts signal to callee + fires SMS "E is calling..."
//   3. Chat shows caller: "Calling..." | callee: "E is calling..." + Answer btn
//   4. Callee taps Answer → _answerCall() → sends 'answered' signal → PeerJS connects
//   5. Either side ends → _endCall() → sends 'ended' signal → chat shows "Call ended • 0:42"
//   6. If peer disconnects unexpectedly → chat shows "Call disconnected"
// ============================================================================

var VideoChat = {
  peer: null,
  currentCall: null,
  localStream: null,
  isInCall: false,
  myPeerId: null,
  dropId: null,
  myRole: null,

  // DOM refs
  overlay: null,
  localVideo: null,
  remoteVideo: null,
  statusEl: null,
  endBtn: null,
  muteBtn: null,
  flipCamBtn: null,
  callBtn: null,
  incomingBanner: null,
  incomingAcceptBtn: null,
  incomingDeclineBtn: null,

  // State
  isMuted: false,
  isFrontCam: true,
  _pendingCall: null,
  _callStartTime: null,   // ms timestamp when remote stream arrived
  _callMsgId: 'active-call',

  init: function(dropId, role) {
    this.dropId = dropId;
    this.myRole = role;
    this.myPeerId = (dropId + '_' + role).replace(/[^a-zA-Z0-9_-]/g, '_');

    this.overlay            = document.getElementById('videoChatOverlay');
    this.localVideo         = document.getElementById('localVideo');
    this.remoteVideo        = document.getElementById('remoteVideo');
    this.statusEl           = document.getElementById('videoChatStatus');
    this.endBtn             = document.getElementById('videoEndBtn');
    this.muteBtn            = document.getElementById('videoMuteBtn');
    this.flipCamBtn         = document.getElementById('videoFlipBtn');
    this.callBtn            = document.getElementById('videoCallBtn');
    this.incomingBanner     = document.getElementById('incomingCallBanner');
    this.incomingAcceptBtn  = document.getElementById('incomingAcceptBtn');
    this.incomingDeclineBtn = document.getElementById('incomingDeclineBtn');

    this._setupButtons();
    this._initPeer();
  },

  _initPeer: function() {
    var self = this;

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
    });

    // Callee receives the actual WebRTC call AFTER they click Answer
    self.peer.on('call', function(call) {
      console.log('[VideoChat] PeerJS call arrived from:', call.peer);
      self._pendingCall = call;
    });

    self.peer.on('error', function(err) {
      console.error('[VideoChat] PeerJS error:', err.type, err);
      if (err.type === 'peer-unavailable') {
        // Normal — callee not open yet; SMS will bring them in
        self._setStatus('Waiting for answer...');
      } else if (err.type === 'unavailable-id') {
        self.myPeerId = self.myPeerId + '_' + Date.now().toString(36).slice(-4);
        console.warn('[VideoChat] ID taken, retrying with:', self.myPeerId);
        self.peer.destroy();
        setTimeout(function() { self._initPeer(); }, 500);
      }
    });

    self.peer.on('disconnected', function() {
      if (!self.peer.destroyed) self.peer.reconnect();
    });
  },

  // ─── Start call (caller side) ────────────────────────────────────────────

  startCall: async function() {
    var self = this;
    if (self.isInCall) { self._showOverlay(); return; }

    var otherRole    = self.myRole === 'M' ? 'E' : 'M';
    var remotePeerId = (self.dropId + '_' + otherRole).replace(/[^a-zA-Z0-9_-]/g, '_');

    try {
      self.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      self.localVideo.srcObject = self.localStream;
      self.localVideo.muted = true;

      self._showOverlay();
      self._setStatus('Calling...');
      self.isInCall = true;
      self._callStartTime = null;

      // ── Chat indicator: caller sees "Calling..." ──
      if (typeof Messages !== 'undefined' && Messages.injectCallMessage) {
        Messages.injectCallMessage({
          id: self._callMsgId,
          role: self.myRole,
          status: 'calling',
          isCaller: true
        });
      }

      // ── Signal server → sends SMS + relays to callee's chat ──
      if (typeof WebSocketManager !== 'undefined') {
        WebSocketManager.sendVideoSignal({
          op: 'incoming',
          from: self.myRole,
          peerId: self.myPeerId
        });
      }

      // PeerJS call — callee may not be ready yet (SMS brings them in)
      var call = self.peer.call(remotePeerId, self.localStream);
      self.currentCall = call;
      self._setupCallHandlers(call);

    } catch (err) {
      console.error('[VideoChat] getUserMedia error:', err);
      self.isInCall = false;
      self._hideOverlay();
      self._showMediaError(err);
    }
  },

  // ─── Answer call (callee side) ────────────────────────────────────────────

  _answerCall: async function() {
    var self = this;
    self._hideIncomingBanner();

    try {
      self.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      self.localVideo.srcObject = self.localStream;
      self.localVideo.muted = true;

      self._showOverlay();
      self._setStatus('Connecting...');
      self.isInCall = true;
      self._callStartTime = null;

      // Update chat to show connecting
      if (typeof Messages !== 'undefined' && Messages.updateCallMessage) {
        Messages.updateCallMessage(self._callMsgId, 'connecting');
      }

      // Notify caller we answered
      if (typeof WebSocketManager !== 'undefined') {
        WebSocketManager.sendVideoSignal({ op: 'answered', from: self.myRole });
      }

      // Answer PeerJS call (may arrive slightly after WS signal)
      if (self._pendingCall) {
        self._pendingCall.answer(self.localStream);
        self.currentCall = self._pendingCall;
        self._pendingCall = null;
        self._setupCallHandlers(self.currentCall);
      } else {
        self._waitForPeerCall();
      }

    } catch (err) {
      console.error('[VideoChat] _answerCall error:', err);
      self.isInCall = false;
      self._hideOverlay();
      self._showMediaError(err);
    }
  },

  _waitForPeerCall: function() {
    var self = this;
    var attempts = 0;
    var interval = setInterval(function() {
      attempts++;
      if (self._pendingCall) {
        clearInterval(interval);
        self._pendingCall.answer(self.localStream);
        self.currentCall = self._pendingCall;
        self._pendingCall = null;
        self._setupCallHandlers(self.currentCall);
      } else if (attempts > 20) { // 10 sec timeout
        clearInterval(interval);
        self._setStatus('Could not connect');
        setTimeout(function() { self._endCallInternal(true, 'disconnected'); }, 2000);
      }
    }, 500);
  },

  _declineCall: function() {
    this._hideIncomingBanner();
    if (this._pendingCall) { this._pendingCall.close(); this._pendingCall = null; }
    if (typeof Messages !== 'undefined' && Messages.updateCallMessage) {
      Messages.updateCallMessage(this._callMsgId, 'declined');
    }
    if (typeof WebSocketManager !== 'undefined') {
      WebSocketManager.sendVideoSignal({ op: 'declined', from: this.myRole });
    }
  },

  // ─── Call stream + lifecycle handlers ────────────────────────────────────

  _setupCallHandlers: function(call) {
    var self = this;

    call.on('stream', function(remoteStream) {
      console.log('[VideoChat] Remote stream received');
      self.remoteVideo.srcObject = remoteStream;
      self._setStatus('');
      self._callStartTime = Date.now();

      if (typeof Messages !== 'undefined' && Messages.updateCallMessage) {
        Messages.updateCallMessage(self._callMsgId, 'connected');
      }
    });

    call.on('close', function() {
      console.log('[VideoChat] Remote closed call');
      var wasConnected = !!self._callStartTime;
      self._endCallInternal(false, wasConnected ? 'ended' : 'disconnected');
    });

    call.on('error', function(err) {
      console.error('[VideoChat] Call error:', err);
      self._endCallInternal(false, 'disconnected');
    });
  },

  // ─── End call ─────────────────────────────────────────────────────────────

  // Public: called by End button or role switch
  _endCall: function(notify) {
    if (notify === undefined) notify = true;
    var wasConnected = !!this._callStartTime;
    this._endCallInternal(notify, wasConnected ? 'ended' : 'missed');
  },

  _endCallInternal: function(sendSignal, finalStatus) {
    var duration = 0;
    if (this._callStartTime) {
      duration = Math.round((Date.now() - this._callStartTime) / 1000);
    }
    this._callStartTime = null;

    if (this.currentCall) {
      try { this.currentCall.close(); } catch(e) {}
      this.currentCall = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(function(t) { t.stop(); });
      this.localStream = null;
    }
    if (this.localVideo)  this.localVideo.srcObject  = null;
    if (this.remoteVideo) this.remoteVideo.srcObject = null;

    this.isInCall = false;
    this.isMuted  = false;
    this._hideOverlay();
    this._hideIncomingBanner();

    // Update chat indicator with final state + duration
    if (typeof Messages !== 'undefined' && Messages.updateCallMessage) {
      Messages.updateCallMessage(this._callMsgId, finalStatus, duration);
    }

    // Tell other side
    if (sendSignal && typeof WebSocketManager !== 'undefined') {
      WebSocketManager.sendVideoSignal({
        op: 'ended',
        from: this.myRole,
        duration: duration,
        reason: finalStatus
      });
    }
  },

  // ─── Handle incoming WS video signals ─────────────────────────────────────

  handleSignal: function(payload) {
    var op   = payload.op;
    var from = payload.from;
    var self = this;

    if (op === 'incoming') {
      // We are the CALLEE
      if (!this.isInCall) {
        if (typeof Messages !== 'undefined' && Messages.injectCallMessage) {
          Messages.injectCallMessage({
            id: self._callMsgId,
            role: from,
            status: 'incoming',
            isCaller: false
          });
        }
        this._showIncomingBanner(from);
      }

    } else if (op === 'answered') {
      // We are the CALLER, callee answered
      this._setStatus('Connecting...');
      if (typeof Messages !== 'undefined' && Messages.updateCallMessage) {
        Messages.updateCallMessage(this._callMsgId, 'connecting');
      }

    } else if (op === 'declined') {
      if (typeof Messages !== 'undefined' && Messages.updateCallMessage) {
        Messages.updateCallMessage(this._callMsgId, 'declined');
      }
      setTimeout(function() { self._endCallInternal(false, 'declined'); }, 1500);

    } else if (op === 'ended') {
      var duration = payload.duration || 0;
      var reason   = payload.reason   || 'ended';
      if (this.isInCall) {
        this._endCallInternal(false, reason);
      } else {
        this._hideIncomingBanner();
        if (typeof Messages !== 'undefined' && Messages.updateCallMessage) {
          Messages.updateCallMessage(this._callMsgId, reason, duration);
        }
      }
    }
  },

  // ─── Mute / flip ──────────────────────────────────────────────────────────

  toggleMute: function() {
    if (!this.localStream) return;
    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach(function(t) { t.enabled = !VideoChat.isMuted; });
    if (this.muteBtn) {
      this.muteBtn.classList.toggle('active', this.isMuted);
      this.muteBtn.setAttribute('aria-label', this.isMuted ? 'Unmute' : 'Mute');
      this.muteBtn.querySelector('.vc-icon').innerHTML = this.isMuted ? ICONS.micOff : ICONS.micOn;
    }
  },

  flipCamera: async function() {
    if (!this.localStream || !this.currentCall) return;
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
      if (sender) sender.replaceTrack(newVideoTrack);
      var oldVideo = self.localStream.getVideoTracks()[0];
      if (oldVideo) oldVideo.stop();
      self.localStream.removeTrack(oldVideo);
      self.localStream.addTrack(newVideoTrack);
      self.localVideo.srcObject = self.localStream;
    } catch (err) {
      console.error('[VideoChat] Flip camera error:', err);
    }
  },

  // ─── UI helpers ───────────────────────────────────────────────────────────

  _showOverlay: function() {
    if (this.overlay) this.overlay.classList.add('show');
    document.body.classList.add('no-scroll');
  },

  _hideOverlay: function() {
    if (this.overlay) this.overlay.classList.remove('show');
    document.body.classList.remove('no-scroll');
  },

  _setStatus: function(text) {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.style.display = text ? 'block' : 'none';
  },

  _showIncomingBanner: function(callerRole) {
    if (!this.incomingBanner) return;
    var nameEl = this.incomingBanner.querySelector('.incoming-caller-name');
    if (nameEl) nameEl.textContent = callerRole === 'E' ? 'E' : 'M';
    this.incomingBanner.classList.add('show');
  },

  _hideIncomingBanner: function() {
    if (this.incomingBanner) this.incomingBanner.classList.remove('show');
  },

  _showMediaError: function(err) {
    var msg = 'Camera/mic unavailable';
    if (err && err.name === 'NotAllowedError') msg = 'Camera/mic permission denied';
    if (err && err.name === 'NotFoundError')   msg = 'No camera/mic found';
    var toast = document.createElement('div');
    toast.className = 'upload-toast error';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function() { toast.classList.add('show'); }, 10);
    setTimeout(function() {
      toast.classList.remove('show');
      setTimeout(function() { toast.remove(); }, 300);
    }, 3000);
  },

  _setupButtons: function() {
    var self = this;
    if (self.endBtn)             self.endBtn.addEventListener('click', function() { self._endCall(true); });
    if (self.muteBtn)            self.muteBtn.addEventListener('click', function() { self.toggleMute(); });
    if (self.flipCamBtn)         self.flipCamBtn.addEventListener('click', function() { self.flipCamera(); });
    if (self.callBtn)            self.callBtn.addEventListener('click', function() { self.startCall(); });
    if (self.incomingAcceptBtn)  self.incomingAcceptBtn.addEventListener('click', function() { self._answerCall(); });
    if (self.incomingDeclineBtn) self.incomingDeclineBtn.addEventListener('click', function() { self._declineCall(); });
  }
};

// SVG icons for mute toggle
var ICONS = {
  micOn:  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
};
