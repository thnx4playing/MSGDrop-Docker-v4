// Path: html/js/videochat.js
// ============================================================================
// VIDEOCHAT.JS - FaceTime-style WebRTC video chat using PeerJS
// ============================================================================
// Uses PeerJS for signaling + WebRTC for media.
// Peer IDs: "{dropId}_{role}" e.g. "default_M", "default_E"
// Call flow: Caller creates call → callee receives 'video_incoming' via WS → callee answers
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

  init: function(dropId, role) {
    this.dropId = dropId;
    this.myRole = role;
    this.myPeerId = (dropId + '_' + role).replace(/[^a-zA-Z0-9_-]/g, '_');

    this.overlay = document.getElementById('videoChatOverlay');
    this.localVideo = document.getElementById('localVideo');
    this.remoteVideo = document.getElementById('remoteVideo');
    this.statusEl = document.getElementById('videoChatStatus');
    this.endBtn = document.getElementById('videoEndBtn');
    this.muteBtn = document.getElementById('videoMuteBtn');
    this.flipCamBtn = document.getElementById('videoFlipBtn');
    this.callBtn = document.getElementById('videoCallBtn');
    this.incomingBanner = document.getElementById('incomingCallBanner');
    this.incomingAcceptBtn = document.getElementById('incomingAcceptBtn');
    this.incomingDeclineBtn = document.getElementById('incomingDeclineBtn');

    this._setupButtons();
    this._initPeer();
  },

  _initPeer: function() {
    var self = this;

    // PeerJS using their free cloud signaling server
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
      console.log('[VideoChat] PeerJS connected, ID:', id);
    });

    // Receive an incoming call
    self.peer.on('call', function(call) {
      console.log('[VideoChat] Incoming call from:', call.peer);
      self._pendingCall = call;

      // Show incoming call banner
      var callerRole = call.peer.split('_').pop();
      self._showIncomingBanner(callerRole);
    });

    self.peer.on('error', function(err) {
      console.error('[VideoChat] PeerJS error:', err);
      if (err.type === 'peer-unavailable') {
        self._setStatus('Contact is not available');
        setTimeout(function() { self._endCall(false); }, 2000);
      } else if (err.type === 'unavailable-id') {
        // ID taken - reconnect with different suffix
        self.myPeerId = self.myPeerId + '_' + Date.now().toString(36).slice(-4);
        console.warn('[VideoChat] ID taken, retrying with:', self.myPeerId);
        self.peer.destroy();
        setTimeout(function() { self._initPeer(); }, 500);
      }
    });

    self.peer.on('disconnected', function() {
      console.warn('[VideoChat] PeerJS disconnected, reconnecting...');
      if (!self.peer.destroyed) {
        self.peer.reconnect();
      }
    });
  },

  // Initiate a call
  startCall: async function() {
    var self = this;
    if (self.isInCall) { self._showOverlay(); return; }

    var otherRole = self.myRole === 'M' ? 'E' : 'M';
    var remotePeerId = (self.dropId + '_' + otherRole).replace(/[^a-zA-Z0-9_-]/g, '_');

    try {
      self.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      self.localVideo.srcObject = self.localStream;
      self.localVideo.muted = true; // never echo own audio

      self._showOverlay();
      self._setStatus('Calling...');

      // Notify other user via WebSocket
      if (typeof WebSocketManager !== 'undefined') {
        WebSocketManager.sendVideoSignal({
          op: 'incoming',
          from: self.myRole,
          peerId: self.myPeerId
        });
      }

      var call = self.peer.call(remotePeerId, self.localStream);
      self.currentCall = call;
      self.isInCall = true;

      self._setupCallHandlers(call);

    } catch (err) {
      console.error('[VideoChat] getUserMedia error:', err);
      self._showMediaError(err);
    }
  },

  // Answer incoming call
  _answerCall: async function() {
    var self = this;
    var call = self._pendingCall;
    if (!call) return;

    self._hideIncomingBanner();

    try {
      self.localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      self.localVideo.srcObject = self.localStream;
      self.localVideo.muted = true;

      call.answer(self.localStream);
      self.currentCall = call;
      self.isInCall = true;
      self._pendingCall = null;

      self._showOverlay();
      self._setStatus('Connecting...');
      self._setupCallHandlers(call);

    } catch (err) {
      console.error('[VideoChat] Answer error:', err);
      self._showMediaError(err);
    }
  },

  _declineCall: function() {
    this._hideIncomingBanner();
    if (this._pendingCall) {
      this._pendingCall.close();
      this._pendingCall = null;
    }
    // Notify caller we declined
    if (typeof WebSocketManager !== 'undefined') {
      WebSocketManager.sendVideoSignal({ op: 'declined', from: this.myRole });
    }
  },

  _setupCallHandlers: function(call) {
    var self = this;

    call.on('stream', function(remoteStream) {
      console.log('[VideoChat] Got remote stream');
      self.remoteVideo.srcObject = remoteStream;
      self._setStatus('');
    });

    call.on('close', function() {
      console.log('[VideoChat] Call closed');
      self._endCall(false);
    });

    call.on('error', function(err) {
      console.error('[VideoChat] Call error:', err);
      self._endCall(false);
    });
  },

  _endCall: function(notify) {
    if (notify === undefined) notify = true;

    if (this.currentCall) {
      this.currentCall.close();
      this.currentCall = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(function(t) { t.stop(); });
      this.localStream = null;
    }
    if (this.localVideo) { this.localVideo.srcObject = null; }
    if (this.remoteVideo) { this.remoteVideo.srcObject = null; }

    this.isInCall = false;
    this.isMuted = false;
    this._hideOverlay();

    if (notify && typeof WebSocketManager !== 'undefined') {
      WebSocketManager.sendVideoSignal({ op: 'ended', from: this.myRole });
    }
  },

  toggleMute: function() {
    if (!this.localStream) return;
    this.isMuted = !this.isMuted;
    this.localStream.getAudioTracks().forEach(function(t) {
      t.enabled = !VideoChat.isMuted;
    });
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

      if (sender) {
        sender.replaceTrack(newVideoTrack);
      }

      // Replace local stream video track
      var oldVideo = self.localStream.getVideoTracks()[0];
      if (oldVideo) oldVideo.stop();
      self.localStream.removeTrack(oldVideo);
      self.localStream.addTrack(newVideoTrack);
      self.localVideo.srcObject = self.localStream;

    } catch (err) {
      console.error('[VideoChat] Flip camera error:', err);
    }
  },

  // Handle incoming video signal from WebSocket
  handleSignal: function(payload) {
    var op = payload.op;
    if (op === 'incoming') {
      // Other user is calling us
      if (!this.isInCall) {
        // Store caller info but PeerJS will handle the actual call via peer.on('call')
        console.log('[VideoChat] Incoming call signal from:', payload.from);
      }
    } else if (op === 'declined') {
      this._setStatus('Call declined');
      setTimeout(function() { VideoChat._endCall(false); }, 1500);
    } else if (op === 'ended') {
      if (this.isInCall) {
        this._endCall(false);
      } else {
        this._hideIncomingBanner();
        this._pendingCall = null;
      }
    }
  },

  // ---- UI helpers ----

  _showOverlay: function() {
    if (!this.overlay) return;
    this.overlay.classList.add('show');
    document.body.classList.add('no-scroll');
  },

  _hideOverlay: function() {
    if (!this.overlay) return;
    this.overlay.classList.remove('show');
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
    if (!this.incomingBanner) return;
    this.incomingBanner.classList.remove('show');
  },

  _showMediaError: function(err) {
    var msg = 'Camera/mic unavailable';
    if (err && err.name === 'NotAllowedError') msg = 'Camera/mic permission denied';
    if (err && err.name === 'NotFoundError') msg = 'No camera/mic found';

    this._hideOverlay();
    var toast = document.createElement('div');
    toast.className = 'upload-toast error';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function() { toast.classList.add('show'); }, 10);
    setTimeout(function() { toast.classList.remove('show'); setTimeout(function() { toast.remove(); }, 300); }, 3000);
  },

  _setupButtons: function() {
    var self = this;

    if (self.endBtn) {
      self.endBtn.addEventListener('click', function() { self._endCall(true); });
    }
    if (self.muteBtn) {
      self.muteBtn.addEventListener('click', function() { self.toggleMute(); });
    }
    if (self.flipCamBtn) {
      self.flipCamBtn.addEventListener('click', function() { self.flipCamera(); });
    }
    if (self.callBtn) {
      self.callBtn.addEventListener('click', function() { self.startCall(); });
    }
    if (self.incomingAcceptBtn) {
      self.incomingAcceptBtn.addEventListener('click', function() { self._answerCall(); });
    }
    if (self.incomingDeclineBtn) {
      self.incomingDeclineBtn.addEventListener('click', function() { self._declineCall(); });
    }
  }
};

// SVG icon snippets for mute button
var ICONS = {
  micOn: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
};
