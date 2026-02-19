// Path: html/js/audio.js
// ============================================================================
// AUDIO.JS - iMessage-style audio messages
// Hold mic button to record (max 60s), release to send
// ============================================================================

var Audio = {
  mediaRecorder: null,
  audioChunks: [],
  isRecording: false,
  recordingTimer: null,
  recordingStartTime: null,
  MAX_DURATION_MS: 60000, // 60 seconds

  // DOM refs set in init
  micBtn: null,
  recordingOverlay: null,
  recordingTimer_el: null,
  recordingWave: null,

  init: function() {
    this.micBtn = document.getElementById('micBtn');
    this.recordingOverlay = document.getElementById('audioRecordingOverlay');
    this.recordingTimer_el = document.getElementById('recordingTimerDisplay');
    this.recordingWave = document.getElementById('recordingWaveform');

    if (!this.micBtn) return;

    // Touch events for hold-to-record
    this.micBtn.addEventListener('touchstart', function(e) {
      e.preventDefault();
      Audio.startRecording();
    }, { passive: false });

    this.micBtn.addEventListener('touchend', function(e) {
      e.preventDefault();
      Audio.stopAndSend();
    }, { passive: false });

    this.micBtn.addEventListener('touchcancel', function(e) {
      e.preventDefault();
      Audio.cancelRecording();
    }, { passive: false });

    // Mouse events for desktop testing
    this.micBtn.addEventListener('mousedown', function(e) {
      e.preventDefault();
      Audio.startRecording();
    });

    document.addEventListener('mouseup', function() {
      if (Audio.isRecording) {
        Audio.stopAndSend();
      }
    });

    // Swipe up on overlay to cancel
    if (this.recordingOverlay) {
      var startY = 0;
      this.recordingOverlay.addEventListener('touchmove', function(e) {
        var dy = startY - e.touches[0].clientY;
        if (dy > 50) {
          Audio.cancelRecording();
        }
      }, { passive: true });
      this.recordingOverlay.addEventListener('touchstart', function(e) {
        startY = e.touches[0].clientY;
      }, { passive: true });
    }
  },

  startRecording: async function() {
    if (this.isRecording) return;

    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

      var mimeType = 'audio/webm';
      if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      } else if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      }

      this.audioChunks = [];
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });

      this.mediaRecorder.ondataavailable = function(e) {
        if (e.data && e.data.size > 0) {
          Audio.audioChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = function() {
        stream.getTracks().forEach(function(t) { t.stop(); });
        Audio._onRecordingFinished(mimeType);
      };

      this.mediaRecorder.start(100); // collect data every 100ms
      this.isRecording = true;
      this.recordingStartTime = Date.now();

      // Show overlay
      this._showRecordingUI();

      // Auto-stop at 60s
      this.recordingTimer = setTimeout(function() {
        if (Audio.isRecording) {
          Audio.stopAndSend();
        }
      }, this.MAX_DURATION_MS);

    } catch (err) {
      console.error('[Audio] Mic permission denied:', err);
      this._showPermissionError();
    }
  },

  stopAndSend: function() {
    if (!this.isRecording) return;
    this.isRecording = false;
    clearTimeout(this.recordingTimer);
    this._hideRecordingUI();
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      // _onRecordingFinished called in onstop handler
    }
  },

  cancelRecording: function() {
    if (!this.isRecording) return;
    this.isRecording = false;
    clearTimeout(this.recordingTimer);
    this._hideRecordingUI();
    this.audioChunks = [];
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.onstop = function() {
        // discard - stream was already stopped
      };
      this.mediaRecorder.stop();
    }
    this._showCancelFeedback();
  },

  _onRecordingFinished: function(mimeType) {
    var duration = Date.now() - this.recordingStartTime;
    if (duration < 500 || this.audioChunks.length === 0) {
      console.log('[Audio] Recording too short, discarding');
      return;
    }
    var blob = new Blob(this.audioChunks, { type: mimeType });
    var ext = mimeType.includes('mp4') ? '.m4a' : '.webm';
    this._uploadAudio(blob, ext, Math.round(duration));
  },

  _uploadAudio: async function(blob, ext, durationMs) {
    var dropId = (typeof App !== 'undefined') ? App.dropId : 'default';
    var user = (typeof App !== 'undefined') ? App.myRole : null;

    var formData = new FormData();
    formData.append('file', blob, 'voice' + ext);
    if (user) formData.append('user', user);
    formData.append('audio_duration', durationMs);

    try {
      var apiBase = (typeof CONFIG !== 'undefined') ? CONFIG.API_BASE_URL : '/api';
      var url = apiBase.replace(/\/$/, '') + '/chat/' + encodeURIComponent(dropId);

      var res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);

      var data = await res.json();
      if (typeof Messages !== 'undefined') {
        Messages.applyDrop(data);
      }
    } catch (err) {
      console.error('[Audio] Upload failed:', err);
      Audio._showUploadError();
    }
  },

  // Playback a blob URL or server URL
  playAudio: function(url, btnEl) {
    var existing = btnEl._audioEl;
    if (existing && !existing.paused) {
      existing.pause();
      btnEl.classList.remove('playing');
      return;
    }
    if (existing) {
      existing.pause();
      existing.currentTime = 0;
    }

    var audioEl = new window.Audio(url);
    btnEl._audioEl = audioEl;

    audioEl.addEventListener('play', function() {
      btnEl.classList.add('playing');
    });
    audioEl.addEventListener('pause', function() {
      btnEl.classList.remove('playing');
    });
    audioEl.addEventListener('ended', function() {
      btnEl.classList.remove('playing');
    });
    audioEl.addEventListener('error', function() {
      btnEl.classList.remove('playing');
      console.error('[Audio] Playback error');
    });

    audioEl.play().catch(function(e) {
      console.error('[Audio] Play failed:', e);
    });
  },

  formatDuration: function(ms) {
    var s = Math.round(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  },

  // ---- UI Helpers ----

  _showRecordingUI: function() {
    if (!this.recordingOverlay) return;
    this.recordingOverlay.classList.add('show');
    this.micBtn.classList.add('recording');

    // Animate waveform bars
    var bars = this.recordingWave ? this.recordingWave.querySelectorAll('.wave-bar') : [];
    bars.forEach(function(b, i) {
      b.style.animationDelay = (i * 0.1) + 's';
    });

    // Update timer every 100ms
    var self = this;
    self._timerInterval = setInterval(function() {
      if (!self.isRecording) { clearInterval(self._timerInterval); return; }
      var elapsed = Date.now() - self.recordingStartTime;
      var remaining = Math.max(0, 60 - Math.floor(elapsed / 1000));
      if (self.recordingTimer_el) {
        self.recordingTimer_el.textContent = '0:' + (remaining < 10 ? '0' : '') + remaining;
      }
    }, 100);
  },

  _hideRecordingUI: function() {
    if (this.recordingOverlay) this.recordingOverlay.classList.remove('show');
    if (this.micBtn) this.micBtn.classList.remove('recording');
    clearInterval(this._timerInterval);
  },

  _showPermissionError: function() {
    var toast = document.createElement('div');
    toast.className = 'upload-toast error';
    toast.textContent = 'Microphone access denied';
    document.body.appendChild(toast);
    setTimeout(function() { toast.classList.add('show'); }, 10);
    setTimeout(function() { toast.classList.remove('show'); setTimeout(function() { toast.remove(); }, 300); }, 2500);
  },

  _showCancelFeedback: function() {
    if (!this.micBtn) return;
    this.micBtn.classList.add('cancelled');
    setTimeout(function() { Audio.micBtn.classList.remove('cancelled'); }, 400);
  },

  _showUploadError: function() {
    var toast = document.createElement('div');
    toast.className = 'upload-toast error';
    toast.textContent = 'Failed to send audio message';
    document.body.appendChild(toast);
    setTimeout(function() { toast.classList.add('show'); }, 10);
    setTimeout(function() { toast.classList.remove('show'); setTimeout(function() { toast.remove(); }, 300); }, 2500);
  }
};
