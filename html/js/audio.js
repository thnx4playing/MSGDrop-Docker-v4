// Path: html/js/audio.js
// ============================================================================
// AUDIO.JS - iMessage-style audio messages
// Tap mic button to start recording; overlay shows with waveform + timer.
// Tap Send in overlay to send, or Cancel to discard.
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
  sendBtn: null,
  cancelBtn: null,

  init: function() {
    this.micBtn          = document.getElementById('micBtn');
    this.recordingOverlay= document.getElementById('audioRecordingOverlay');
    this.recordingTimer_el = document.getElementById('recordingTimerDisplay');
    this.recordingWave   = document.getElementById('recordingWaveform');
    this.sendBtn         = document.getElementById('audioSendBtn');
    this.cancelBtn       = document.getElementById('audioCancelBtn');

    if(!this.micBtn) return;

    // ── Tap to start recording ──
    // Tapping the mic starts recording and opens the overlay.
    // Send / Cancel buttons inside the overlay control what happens next.
    this.micBtn.addEventListener('click', function(e) {
      e.preventDefault();
      if(Audio.isRecording) return; // already recording — handled by overlay buttons
      Audio.startRecording();
    });

    // Overlay Send button → stop recording and upload
    if(this.sendBtn) {
      this.sendBtn.addEventListener('click', function() {
        Audio.stopAndSend();
      });
    }

    // Overlay Cancel button → discard recording
    if(this.cancelBtn) {
      this.cancelBtn.addEventListener('click', function() {
        Audio.cancelRecording();
      });
    }
  },

  startRecording: async function() {
    if(this.isRecording) return;

    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

      var mimeType = 'audio/webm';
      if(MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      } else if(MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
        mimeType = 'audio/webm;codecs=opus';
      }

      this.audioChunks = [];
      this.mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });

      this.mediaRecorder.ondataavailable = function(e) {
        if(e.data && e.data.size > 0) {
          Audio.audioChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = function() {
        stream.getTracks().forEach(function(t) { t.stop(); });
        Audio._onRecordingFinished(mimeType);
      };

      this.mediaRecorder.start(100);
      this.isRecording = true;
      this.recordingStartTime = Date.now();

      this._showRecordingUI();

      // Auto-stop at 60s
      this.recordingTimer = setTimeout(function() {
        if(Audio.isRecording) {
          Audio.stopAndSend();
        }
      }, this.MAX_DURATION_MS);

    } catch(err) {
      console.error('[Audio] Mic permission denied:', err);
      this._showPermissionError();
    }
  },

  stopAndSend: function() {
    if(!this.isRecording) return;
    this.isRecording = false;
    clearTimeout(this.recordingTimer);
    this._hideRecordingUI();
    if(this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
      // _onRecordingFinished is called in the onstop handler
    }
  },

  cancelRecording: function() {
    if(!this.isRecording) return;
    this.isRecording = false;
    clearTimeout(this.recordingTimer);
    this._hideRecordingUI();
    this.audioChunks = [];
    if(this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      // Override onstop to discard the data
      this.mediaRecorder.onstop = function() { /* discard */ };
      this.mediaRecorder.stop();
    }
    this._showCancelFeedback();
  },

  _onRecordingFinished: function(mimeType) {
    var duration = Date.now() - this.recordingStartTime;
    if(duration < 500 || this.audioChunks.length === 0) {
      console.log('[Audio] Recording too short, discarding');
      return;
    }
    var blob = new Blob(this.audioChunks, { type: mimeType });
    var ext = mimeType.includes('mp4') ? '.m4a' : '.webm';
    this._uploadAudio(blob, ext, Math.round(duration));
  },

  _uploadAudio: async function(blob, ext, durationMs) {
    var dropId = (typeof App !== 'undefined') ? App.dropId : 'default';
    var user   = (typeof App !== 'undefined') ? App.myRole : null;

    var formData = new FormData();
    formData.append('file', blob, 'voice' + ext);
    if(user) formData.append('user', user);
    formData.append('audio_duration', durationMs);

    // Show a sending indicator on the mic button
    if(this.micBtn) this.micBtn.classList.add('uploading');

    try {
      var apiBase = (typeof CONFIG !== 'undefined') ? CONFIG.API_BASE_URL : '/api';
      var url = apiBase.replace(/\/$/, '') + '/chat/' + encodeURIComponent(dropId);

      var res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        body: formData
      });

      if(!res.ok) throw new Error('HTTP ' + res.status);

      var data = await res.json();
      if(typeof Messages !== 'undefined') {
        Messages.applyDrop(data);
      }
    } catch(err) {
      console.error('[Audio] Upload failed:', err);
      Audio._showUploadError();
    } finally {
      if(Audio.micBtn) Audio.micBtn.classList.remove('uploading');
    }
  },

  // ---- UI Helpers ----

  _showRecordingUI: function() {
    if(!this.recordingOverlay) return;
    this.recordingOverlay.classList.add('show');
    if(this.micBtn) this.micBtn.classList.add('recording');

    // Reset timer display to 0:00
    if(this.recordingTimer_el) this.recordingTimer_el.textContent = '0:00';

    // Animate waveform bars with staggered delays
    var bars = this.recordingWave ? this.recordingWave.querySelectorAll('.wave-bar') : [];
    bars.forEach(function(b, i) {
      b.style.animationDelay = (i * 0.08) + 's';
    });

    // Update timer every 100ms (count UP, not down)
    var self = this;
    self._timerInterval = setInterval(function() {
      if(!self.isRecording) { clearInterval(self._timerInterval); return; }
      var elapsed = Date.now() - self.recordingStartTime;
      var s = Math.floor(elapsed / 1000);
      var m = Math.floor(s / 60);
      s = s % 60;
      if(self.recordingTimer_el) {
        self.recordingTimer_el.textContent = m + ':' + (s < 10 ? '0' : '') + s;
      }
      // Visual warning when getting close to 60s limit
      if(elapsed > 50000 && self.recordingTimer_el) {
        self.recordingTimer_el.style.color = '#ff3b30';
      }
    }, 100);
  },

  _hideRecordingUI: function() {
    if(this.recordingOverlay) this.recordingOverlay.classList.remove('show');
    if(this.micBtn) this.micBtn.classList.remove('recording');
    if(this.recordingTimer_el) this.recordingTimer_el.style.color = '';
    clearInterval(this._timerInterval);
  },

  _showPermissionError: function() {
    var toast = document.createElement('div');
    toast.className = 'upload-toast error';
    toast.textContent = 'Microphone access denied. Please allow microphone in your browser settings.';
    document.body.appendChild(toast);
    setTimeout(function() { toast.classList.add('show'); }, 10);
    setTimeout(function() { toast.classList.remove('show'); setTimeout(function() { toast.remove(); }, 300); }, 3500);
  },

  _showCancelFeedback: function() {
    if(!this.micBtn) return;
    this.micBtn.classList.add('cancelled');
    setTimeout(function() { Audio.micBtn.classList.remove('cancelled'); }, 400);
  },

  _showUploadError: function() {
    var toast = document.createElement('div');
    toast.className = 'upload-toast error';
    toast.textContent = 'Failed to send voice message';
    document.body.appendChild(toast);
    setTimeout(function() { toast.classList.add('show'); }, 10);
    setTimeout(function() { toast.classList.remove('show'); setTimeout(function() { toast.remove(); }, 300); }, 2500);
  }
};
