// Path: html/js/messages.js
// ============================================================================
// MESSAGES.JS - v4: Audio messages + call system messages
// ============================================================================

var Messages = {
  history: [],
  currentVersion: 0,
  editingSeq: null,
  replyingToSeq: null,
  replyingToMessage: null,
  myRole: null,
  lastReadReceiptSent: 0,
  lastReadReceiptSeq: 0,

  formatMessageTime: function(timestamp){
    if(!timestamp) return '';
    var msgDate = new Date(timestamp);
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    var msgDay = new Date(msgDate.getFullYear(), msgDate.getMonth(), msgDate.getDate());
    var timeStr = msgDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    if(msgDay.getTime() === today.getTime()){ return timeStr; }
    else if(msgDay.getTime() === yesterday.getTime()){ return 'Yesterday ' + timeStr; }
    else { return (msgDate.getMonth() + 1) + '/' + msgDate.getDate() + ' ' + timeStr; }
  },

  formatAudioDuration: function(ms){
    if(!ms || ms <= 0) return '0:00';
    var s = Math.round(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  },

  _formatCallDuration: function(seconds){
    if(!seconds || seconds <= 0) return '';
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  },

  isMessageEdited: function(msg){
    if(!msg.createdAt || !msg.updatedAt) return false;
    return new Date(msg.updatedAt).getTime() > new Date(msg.createdAt).getTime();
  },

  bubbleClassFor: function(msg){
    if(this.myRole && msg.user && msg.user === this.myRole) return 'right';
    return 'left';
  },

  getReceiptStatus: function(msg){
    if(!this.myRole || msg.user !== this.myRole) return null;
    if(msg.readAt) return 'read';
    if(msg.deliveredAt) return 'delivered';
    return 'sent';
  },

  findMessageBySeq: function(seq){
    return this.history.find(function(m){ return m.seq === seq; });
  },

  enterReplyMode: function(seq){
    var msg = this.findMessageBySeq(seq);
    if(!msg) return;
    this.replyingToSeq = seq;
    this.replyingToMessage = msg;
    var replyPreview = document.getElementById('replyPreview');
    var replyPreviewText = document.getElementById('replyPreviewText');
    var replyPreviewUser = document.getElementById('replyPreviewUser');
    if(replyPreview && replyPreviewText){
      var previewText = msg.message || '';
      if(msg.messageType === 'gif') previewText = '🎬 GIF';
      if(msg.messageType === 'image') previewText = '📷 Photo';
      if(msg.messageType === 'audio') previewText = '🎤 Voice Message';
      if(typeof RichLinks !== 'undefined' && RichLinks.detectLink(previewText)){
        var link = RichLinks.detectLink(previewText);
        var platform = RichLinks.platforms[link.platform];
        previewText = platform.icon + ' ' + platform.name + ' Video';
      }
      if(previewText.length > 50) previewText = previewText.substring(0, 50) + '...';
      replyPreviewText.textContent = previewText;
      if(replyPreviewUser) replyPreviewUser.textContent = msg.user || 'Unknown';
      replyPreview.classList.add('show');
    }
    if(UI.els.reply) UI.els.reply.focus();
  },

  exitReplyMode: function(){
    this.replyingToSeq = null;
    this.replyingToMessage = null;
    var replyPreview = document.getElementById('replyPreview');
    if(replyPreview) replyPreview.classList.remove('show');
  },

  applyDrop: function(data){
    if(!data) return;
    this.currentVersion = data.version || 0;
    if(data.messages && Array.isArray(data.messages)){
      this.history = data.messages.map(function(msg){
        return {
          message: msg.message || '',
          seq: msg.seq || 0,
          version: msg.seq || 0,
          createdAt: msg.createdAt || msg.updatedAt,
          updatedAt: msg.updatedAt,
          reactions: msg.reactions || {},
          user: msg.user || null,
          clientId: msg.clientId || null,
          messageType: msg.messageType || 'text',
          gifUrl: msg.gifUrl || null,
          gifPreview: msg.gifPreview || null,
          gifWidth: msg.gifWidth || null,
          gifHeight: msg.gifHeight || null,
          imageUrl: msg.imageUrl || null,
          imageThumb: msg.imageThumb || null,
          audioUrl: msg.audioUrl || null,
          audioDuration: msg.audioDuration || 0,
          replyToSeq: msg.replyToSeq || null,
          deliveredAt: msg.deliveredAt || null,
          readAt: msg.readAt || null
        };
      });
      this.render();
      this.sendReadReceipts();
    }
    if(UI.setLive) UI.setLive('Connected');
  },

  sendReadReceipts: function(){
    if(!this.myRole) return;
    var maxUnreadSeq = 0;
    this.history.forEach(function(msg){
      if(msg.user && msg.user !== this.myRole && !msg.readAt && msg.seq > maxUnreadSeq){
        maxUnreadSeq = msg.seq;
      }
    }.bind(this));
    var now = Date.now();
    if(maxUnreadSeq === this.lastReadReceiptSeq && now - this.lastReadReceiptSent < 1000) return;
    if(maxUnreadSeq > 0 && WebSocketManager.ws && WebSocketManager.ws.readyState === 1){
      this.lastReadReceiptSent = now;
      this.lastReadReceiptSeq = maxUnreadSeq;
      WebSocketManager.sendReadReceipt(maxUnreadSeq, this.myRole);
    }
  },

  handleDeliveryReceipt: function(data){
    var msg = this.findMessageBySeq(data.seq);
    if(msg){ msg.deliveredAt = data.deliveredAt; this.render(); }
  },

  handleReadReceipt: function(data){
    var upToSeq = data.upToSeq;
    var reader = data.reader;
    var readAt = data.readAt;
    if(!upToSeq || !reader || !readAt) return;
    var updated = false;
    this.history.forEach(function(msg){
      if(msg.seq <= upToSeq && msg.user && msg.user !== reader && !msg.readAt){
        msg.readAt = readAt;
        updated = true;
      }
    });
    if(updated) this.render();
  },

  hasRichLinks: function(text){
    if(typeof RichLinks === 'undefined') return false;
    return RichLinks.detectLink(text) !== null;
  },

  isOnlyRichLink: function(text){
    if(typeof RichLinks === 'undefined') return false;
    return RichLinks.isOnlyLink(text);
  },

  // =========================================================================
  // CALL SYSTEM MESSAGES
  // =========================================================================

  injectCallMessage: function(opts){
    var container = UI.els.chatContainer;
    if(!container) return;

    var existing = document.getElementById('call-sys-' + opts.id);
    if(existing) existing.remove();

    var el = document.createElement('div');
    el.id = 'call-sys-' + opts.id;
    el.className = 'call-system-message';
    el.setAttribute('data-caller', opts.role || '');
    el.setAttribute('data-is-caller', opts.isCaller ? 'true' : 'false');

    this._renderCallContent(el, opts.role, opts.status, opts.isCaller, 0);

    if(UI.els.typingIndicator){
      container.insertBefore(el, UI.els.typingIndicator);
    } else {
      container.appendChild(el);
    }
    container.scrollTop = container.scrollHeight;
  },

  updateCallMessage: function(id, status, duration){
    var el = document.getElementById('call-sys-' + id);
    if(!el) return;
    var role     = el.getAttribute('data-caller');
    var isCaller = el.getAttribute('data-is-caller') === 'true';
    this._renderCallContent(el, role, status, isCaller, duration || 0);

    // Always re-anchor to the bottom
    var container = UI.els.chatContainer;
    if(container){
      if(UI.els.typingIndicator){
        container.insertBefore(el, UI.els.typingIndicator);
      } else {
        container.appendChild(el);
      }
      container.scrollTop = container.scrollHeight;
    }
  },

  // ─── Call content builder ─────────────────────────────────────────────────
  // 'incoming' renders a centered card with green/red pill buttons.
  // All other states render a compact centered system message row.
  _renderCallContent: function(el, role, status, isCaller, duration){
    el.innerHTML = '';

    var callerName = role || '?';

    // ── INCOMING: full centered card ──────────────────────────────────────
    if(status === 'incoming'){
      el.setAttribute('data-state', 'active');
      el.classList.add('call-incoming-card');

      // Pulsing video camera icon
      var iconWrap = document.createElement('div');
      iconWrap.className = 'call-card-icon-wrap';
      iconWrap.innerHTML =
        '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<polygon points="23 7 16 12 23 17 23 7"/>' +
          '<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>' +
        '</svg>';

      // Name + subtitle
      var label = document.createElement('div');
      label.className = 'call-card-label';

      var nameEl = document.createElement('div');
      nameEl.className = 'call-card-name';
      nameEl.textContent = callerName + ' is calling';

      var subEl = document.createElement('div');
      subEl.className = 'call-card-sub';
      subEl.textContent = 'FaceTime Video';

      label.appendChild(nameEl);
      label.appendChild(subEl);

      // Buttons row
      var actions = document.createElement('div');
      actions.className = 'call-card-actions';

      var declineBtn = document.createElement('button');
      declineBtn.className = 'call-card-btn call-card-decline';
      declineBtn.innerHTML =
        '<span class="call-card-btn-icon">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">' +
            '<path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1-9.4 0-17-7.6-17-17 0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/>' +
          '</svg>' +
        '</span>' +
        '<span class="call-card-btn-label">Decline</span>';
      declineBtn.onclick = function(e){
        e.stopPropagation();
        if(typeof VideoChat !== 'undefined') VideoChat._declineCall();
      };

      var answerBtn = document.createElement('button');
      answerBtn.className = 'call-card-btn call-card-answer';
      answerBtn.innerHTML =
        '<span class="call-card-btn-icon">' +
          '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<polygon points="23 7 16 12 23 17 23 7"/>' +
            '<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>' +
          '</svg>' +
        '</span>' +
        '<span class="call-card-btn-label">Accept</span>';
      answerBtn.onclick = function(e){
        e.stopPropagation();
        if(typeof VideoChat !== 'undefined') VideoChat._answerCall();
      };

      actions.appendChild(declineBtn);
      actions.appendChild(answerBtn);

      el.appendChild(iconWrap);
      el.appendChild(label);
      el.appendChild(actions);
      return;
    }

    // ── All other states: compact centered status row ──────────────────────
    el.classList.remove('call-incoming-card');

    var iconEl = document.createElement('span');
    iconEl.className = 'call-sys-icon';
    var textEl = document.createElement('span');
    textEl.className = 'call-sys-text';
    var meta = document.createElement('span');
    meta.className = 'call-sys-time';
    meta.textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    switch(status){
      case 'calling':
        el.setAttribute('data-state', 'active');
        iconEl.textContent = '📹';
        textEl.textContent = isCaller ? 'Calling...' : callerName + ' is calling...';
        iconEl.classList.add('pulse');
        break;
      case 'connecting':
        el.setAttribute('data-state', 'active');
        iconEl.textContent = '🔄';
        textEl.textContent = 'Connecting...';
        break;
      case 'connected':
        el.setAttribute('data-state', 'active');
        iconEl.textContent = '🟢';
        textEl.textContent = 'Call connected';
        break;
      case 'ended': {
        el.setAttribute('data-state', 'done');
        iconEl.textContent = '📵';
        var dur = duration ? ' · ' + this._formatCallDuration(duration) : '';
        textEl.textContent = 'Call ended' + dur;
        break;
      }
      case 'missed':
        el.setAttribute('data-state', 'done');
        iconEl.textContent = '📵';
        textEl.textContent = isCaller ? 'No answer' : 'Missed call';
        break;
      case 'declined':
        el.setAttribute('data-state', 'done');
        iconEl.textContent = '📵';
        textEl.textContent = isCaller ? 'Call declined' : 'Declined';
        break;
      case 'disconnected':
        el.setAttribute('data-state', 'done');
        iconEl.textContent = '⚠️';
        var dur2 = duration ? ' · ' + this._formatCallDuration(duration) : '';
        textEl.textContent = 'Call disconnected' + dur2;
        break;
      default:
        el.setAttribute('data-state', 'done');
        iconEl.textContent = '📵';
        textEl.textContent = status || 'Call ended';
    }

    el.appendChild(iconEl);
    el.appendChild(textEl);
    el.appendChild(meta);
  },

  // =========================================================================
  // GEO INVITE MESSAGES
  // =========================================================================

  injectGeoInvite: function(opts) {
    var container = UI.els.chatContainer;
    if (!container) return;

    var existing = document.getElementById('geo-invite-' + opts.id);
    if (existing) existing.remove();

    var el = document.createElement('div');
    el.id = 'geo-invite-' + opts.id;
    el.className = 'call-system-message';
    el.setAttribute('data-geo-invite-id', opts.id);

    if (opts.status === 'incoming') {
      el.classList.add('call-incoming-card');

      var iconWrap = document.createElement('div');
      iconWrap.className = 'call-card-icon-wrap geo-invite-icon-wrap';
      iconWrap.innerHTML = '<span style="font-size:28px;line-height:1">🌍</span>';

      var label = document.createElement('div');
      label.className = 'call-card-label';

      var nameEl = document.createElement('div');
      nameEl.className = 'call-card-name';
      nameEl.textContent = (opts.role || '?') + ' wants to play GeoGuessr';

      var subEl = document.createElement('div');
      subEl.className = 'call-card-sub';
      subEl.textContent = '5 rounds \u00b7 60 seconds each';

      label.appendChild(nameEl);
      label.appendChild(subEl);

      var actions = document.createElement('div');
      actions.className = 'call-card-actions';

      var declineBtn = document.createElement('button');
      declineBtn.className = 'call-card-btn call-card-decline';
      declineBtn.innerHTML =
        '<span class="call-card-btn-icon">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">' +
            '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' +
          '</svg>' +
        '</span>' +
        '<span class="call-card-btn-label">Decline</span>';
      declineBtn.onclick = function(e) {
        e.stopPropagation();
        if (typeof GeoGame !== 'undefined') GeoGame.declineInvite();
      };

      var acceptBtn = document.createElement('button');
      acceptBtn.className = 'call-card-btn call-card-answer';
      acceptBtn.innerHTML =
        '<span class="call-card-btn-icon">' +
          '<span style="font-size:18px;line-height:1">🌍</span>' +
        '</span>' +
        '<span class="call-card-btn-label">Accept</span>';
      acceptBtn.onclick = function(e) {
        e.stopPropagation();
        if (typeof GeoGame !== 'undefined') GeoGame.acceptInvite();
      };

      actions.appendChild(declineBtn);
      actions.appendChild(acceptBtn);

      el.appendChild(iconWrap);
      el.appendChild(label);
      el.appendChild(actions);
    }
    else if (opts.status === 'waiting') {
      var iconEl = document.createElement('span');
      iconEl.className = 'call-sys-icon';
      iconEl.textContent = '🌍';
      iconEl.classList.add('pulse');
      var textEl = document.createElement('span');
      textEl.className = 'call-sys-text';
      textEl.textContent = 'Waiting for response...';
      var meta = document.createElement('span');
      meta.className = 'call-sys-time';
      meta.textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      el.appendChild(iconEl);
      el.appendChild(textEl);
      el.appendChild(meta);
    }

    if (UI.els.typingIndicator) {
      container.insertBefore(el, UI.els.typingIndicator);
    } else {
      container.appendChild(el);
    }
    container.scrollTop = container.scrollHeight;
  },

  updateGeoInvite: function(id, status) {
    var el = document.getElementById('geo-invite-' + id);
    if (!el) return;

    if (status === 'starting') {
      // Remove the card — game is starting
      el.classList.remove('call-incoming-card');
      el.innerHTML = '';
      var iconEl = document.createElement('span');
      iconEl.className = 'call-sys-icon';
      iconEl.textContent = '🌍';
      var textEl = document.createElement('span');
      textEl.className = 'call-sys-text';
      textEl.textContent = 'Game starting...';
      el.appendChild(iconEl);
      el.appendChild(textEl);
      el.setAttribute('data-state', 'done');
      setTimeout(function() { if (el.parentNode) el.remove(); }, 2000);
    }
    else if (status === 'declined') {
      el.classList.remove('call-incoming-card');
      el.innerHTML = '';
      var iconEl2 = document.createElement('span');
      iconEl2.className = 'call-sys-icon';
      iconEl2.textContent = '🌍';
      var textEl2 = document.createElement('span');
      textEl2.className = 'call-sys-text';
      textEl2.textContent = 'GeoGuessr declined';
      el.appendChild(iconEl2);
      el.appendChild(textEl2);
      el.setAttribute('data-state', 'done');
    }
  },

  // =========================================================================
  // AUDIO BUBBLE
  // =========================================================================

  _buildAudioBubble: function(msg, isOwn){
    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble audio-message';

    var duration = this.formatAudioDuration(msg.audioDuration);
    // audioUrl is canonical; fall back to imageUrl for legacy records
    var audioUrl = msg.audioUrl || msg.imageUrl || null;

    var barCount = 24;
    var waveContainer = document.createElement('div');
    waveContainer.className = 'audio-waveform';
    for(var i = 0; i < barCount; i++){
      var bar = document.createElement('span');
      bar.className = 'audio-bar';
      var seed = ((msg.seq || 1) * 31 + i * 17) % 100;
      bar.style.height = (20 + (seed % 60)) + '%';
      waveContainer.appendChild(bar);
    }

    var playBtn = document.createElement('button');
    playBtn.className = 'audio-play-btn';
    playBtn.setAttribute('aria-label', 'Play voice message');
    playBtn.setAttribute('type', 'button');
    playBtn.innerHTML =
      '<svg class="play-icon" viewBox="0 0 24 24" width="20" height="20"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>' +
      '<svg class="pause-icon" viewBox="0 0 24 24" width="20" height="20"><rect x="5" y="3" width="4" height="18" rx="1" fill="currentColor"/><rect x="15" y="3" width="4" height="18" rx="1" fill="currentColor"/></svg>';

    var durLabel = document.createElement('span');
    durLabel.className = 'audio-duration';
    durLabel.textContent = duration;

    bubble.appendChild(playBtn);
    bubble.appendChild(waveContainer);
    bubble.appendChild(durLabel);

    if(audioUrl){
      (function(btn, url, dLabel, waveEl, msgSeq, totalBars){

        // ── Create the <audio> element upfront (not lazily) ──────────────
        // Using document.createElement('audio') is more reliable on iOS Safari
        // than new Audio(). We append it to body (hidden) because iOS WKWebView
        // requires audio elements to be in the DOM to initialise correctly.
        var audioEl = document.createElement('audio');
        audioEl.setAttribute('playsinline', '');
        audioEl.setAttribute('webkit-playsinline', '');
        audioEl.preload = 'none'; // don't download until user taps play
        // ── DO NOT set crossOrigin ──────────────────────────────────────
        // /blob/ is same-origin and needs session cookies.
        // crossOrigin='anonymous' strips cookies → 401 → silent failure.
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
        btn._audioEl = audioEl;

        audioEl.addEventListener('timeupdate', function(){
          if(!audioEl.duration || isNaN(audioEl.duration)) return;
          var pct = audioEl.currentTime / audioEl.duration;
          var filled = Math.round(pct * totalBars);
          var bars = waveEl.querySelectorAll('.audio-bar');
          bars.forEach(function(b, i){ b.classList.toggle('played', i < filled); });
          var remaining = audioEl.duration - audioEl.currentTime;
          var rs = Math.round(remaining);
          var rm = Math.floor(rs / 60); rs = rs % 60;
          dLabel.textContent = rm + ':' + (rs < 10 ? '0' : '') + rs;
        });

        audioEl.addEventListener('ended', function(){
          btn.classList.remove('playing');
          waveEl.querySelectorAll('.audio-bar').forEach(function(b){ b.classList.remove('played'); });
          if(typeof Messages !== 'undefined'){
            var origMsg = Messages.findMessageBySeq(msgSeq);
            if(origMsg) dLabel.textContent = Messages.formatAudioDuration(origMsg.audioDuration);
          }
        });

        audioEl.addEventListener('error', function(){
          btn.classList.remove('playing');
          var code = audioEl.error ? audioEl.error.code : '?';
          console.error('[Audio] Element error code:', code, 'URL:', audioEl.src);
          // Show visible error toast so user knows something went wrong
          var toast = document.createElement('div');
          toast.className = 'upload-toast error';
          toast.textContent = 'Could not play audio (err ' + code + ')';
          document.body.appendChild(toast);
          setTimeout(function(){ toast.classList.add('show'); }, 10);
          setTimeout(function(){ toast.classList.remove('show'); setTimeout(function(){ toast.remove(); }, 300); }, 3000);
        });

        btn.addEventListener('click', function(e){
          e.stopPropagation();

          // Toggle pause if already playing
          if(!audioEl.paused){
            audioEl.pause();
            btn.classList.remove('playing');
            return;
          }

          // Pause any other currently-playing audio
          document.querySelectorAll('.audio-play-btn.playing').forEach(function(b){
            b.classList.remove('playing');
            if(b._audioEl && !b._audioEl.paused) b._audioEl.pause();
          });

          // Set/reset src so iOS re-fetches (handles session renewal too)
          if(!audioEl.src || audioEl.ended) {
            audioEl.src = url;
            audioEl.load();
          }

          // ── Safe play() wrapper ──────────────────────────────────────
          // On older Safari, play() returns undefined (not a Promise).
          // Calling .then() on undefined throws a TypeError which silently
          // swallows the whole handler — button never shows pause state.
          var playResult;
          try {
            playResult = audioEl.play();
          } catch(syncErr) {
            console.error('[Audio] play() threw synchronously:', syncErr);
            return;
          }

          if(playResult && typeof playResult.then === 'function'){
            playResult.then(function(){
              btn.classList.add('playing');
            }).catch(function(err){
              console.error('[Audio] play() rejected:', err.name, err.message, 'URL:', url);
            });
          } else {
            // Non-promise play() (old Safari) — assume it started; error event handles failure
            btn.classList.add('playing');
          }
        });
      })(playBtn, audioUrl, durLabel, waveContainer, msg.seq, barCount);
    } else {
      playBtn.disabled = true;
      playBtn.style.opacity = '0.4';
      playBtn.title = 'Audio not available';
    }

    return bubble;
  },

  // =========================================================================
  // RENDER
  // =========================================================================

  render: function(){
    if(!UI.els.chatContainer) return;
    var wasAtBottom = UI.els.chatContainer.scrollHeight - UI.els.chatContainer.scrollTop <= UI.els.chatContainer.clientHeight + 50;

    // Save call system messages – they live outside .message-group
    var callSysMessages = Array.from(UI.els.chatContainer.querySelectorAll('.call-system-message'));

    var existingMessages = UI.els.chatContainer.querySelectorAll('.message-group');
    existingMessages.forEach(function(el){ el.remove(); });

    this.history.forEach(function(msg, index){
      if(!msg || !msg.message) return;

      var bubbleClass = this.bubbleClassFor(msg);
      var isOwnMessage = bubbleClass === 'right';

      var group = document.createElement('div');
      group.className = 'message-group ' + bubbleClass;
      group.setAttribute('data-seq', msg.seq || msg.version);

      // Reply bubble
      if(msg.replyToSeq){
        var repliedMsg = this.findMessageBySeq(msg.replyToSeq);
        if(repliedMsg){
          var replyBubble = document.createElement('div');
          replyBubble.className = 'reply-bubble';
          var replyLine = document.createElement('div');
          replyLine.className = 'reply-line';
          var replyContent = document.createElement('div');
          replyContent.className = 'reply-content';
          var replyAuthor = document.createElement('span');
          replyAuthor.className = 'reply-author';
          replyAuthor.textContent = repliedMsg.user || 'Unknown';
          var replyText = document.createElement('span');
          replyText.className = 'reply-text';
          var replyTextContent = repliedMsg.message || '';
          if(repliedMsg.messageType === 'gif') replyTextContent = '🎬 GIF';
          if(repliedMsg.messageType === 'image') replyTextContent = '📷 Photo';
          if(repliedMsg.messageType === 'audio') replyTextContent = '🎤 Voice Message';
          if(typeof RichLinks !== 'undefined' && RichLinks.detectLink(replyTextContent)){
            var link = RichLinks.detectLink(replyTextContent);
            var platform = RichLinks.platforms[link.platform];
            replyTextContent = platform.icon + ' ' + platform.name + ' Video';
          }
          if(replyTextContent.length > 40) replyTextContent = replyTextContent.substring(0, 40) + '...';
          replyText.textContent = replyTextContent;
          replyContent.appendChild(replyAuthor);
          replyContent.appendChild(replyText);
          replyBubble.appendChild(replyLine);
          replyBubble.appendChild(replyContent);
          replyBubble.addEventListener('click', function(e){
            e.stopPropagation();
            var originalGroup = document.querySelector('.message-group[data-seq="' + msg.replyToSeq + '"]');
            if(originalGroup){
              originalGroup.scrollIntoView({ behavior: 'smooth', block: 'center' });
              originalGroup.classList.add('highlight-flash');
              setTimeout(function(){ originalGroup.classList.remove('highlight-flash'); }, 1500);
            }
          });
          group.appendChild(replyBubble);
        }
      }

      var bubble;

      // ---- AUDIO ----
      if(msg.messageType === 'audio'){
        bubble = this._buildAudioBubble(msg, isOwnMessage);
      }
      // ---- IMAGE ----
      else if(msg.messageType === 'image' && msg.imageUrl){
        bubble = document.createElement('div');
        bubble.className = 'chat-bubble image-message';
        var imageContainer = document.createElement('div');
        imageContainer.className = 'image-container';
        var imgEl = document.createElement('img');
        imgEl.src = msg.imageThumb || msg.imageUrl;
        imgEl.alt = msg.message || 'Image';
        imgEl.className = 'image-thumbnail';
        imgEl.loading = 'lazy';
        var originalUrl = msg.imageUrl || msg.imageThumb || '';
        imgEl.addEventListener('load', function(){
          if(UI.els.chatContainer){
            var atBottom = UI.els.chatContainer.scrollHeight - UI.els.chatContainer.scrollTop <= UI.els.chatContainer.clientHeight + 100;
            if(atBottom) UI.els.chatContainer.scrollTop = UI.els.chatContainer.scrollHeight;
          }
        });
        (function(imgEl2, fullUrl, bubbleEl){
          var longPressTimer = null, longPressTriggered = false, touchHandled = false;
          var touchStartX = 0, touchStartY = 0, LONG_PRESS_DURATION = 500, MOVE_THRESHOLD = 10;
          function openLightbox(){ if(fullUrl && UI.openLightbox) UI.openLightbox(fullUrl + '?t=' + Date.now()); }
          function openActionsModal(){ if(bubbleEl.closest('.message-group') && Reactions && Reactions.openPicker) Reactions.openPicker(bubbleEl); }
          function clearLongPress(){ if(longPressTimer){ clearTimeout(longPressTimer); longPressTimer = null; } }
          imgEl2.addEventListener('touchstart', function(e){ longPressTriggered = false; touchHandled = false; touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY; longPressTimer = setTimeout(function(){ longPressTriggered = true; touchHandled = true; if(navigator.vibrate) navigator.vibrate(50); openActionsModal(); }, LONG_PRESS_DURATION); }, { passive: true });
          imgEl2.addEventListener('touchmove', function(e){ var dx = Math.abs(e.touches[0].clientX - touchStartX); var dy = Math.abs(e.touches[0].clientY - touchStartY); if(dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) clearLongPress(); }, { passive: true });
          imgEl2.addEventListener('touchend', function(e){ clearLongPress(); if(!longPressTriggered){ touchHandled = true; e.preventDefault(); e.stopPropagation(); openLightbox(); } longPressTriggered = false; });
          imgEl2.addEventListener('touchcancel', function(){ clearLongPress(); longPressTriggered = false; touchHandled = false; });
          imgEl2.addEventListener('click', function(e){ e.stopPropagation(); e.preventDefault(); if(touchHandled){ touchHandled = false; return; } openLightbox(); });
          imgEl2.addEventListener('contextmenu', function(e){ e.preventDefault(); e.stopPropagation(); openActionsModal(); });
        })(imgEl, originalUrl, bubble);
        imageContainer.appendChild(imgEl);
        bubble.appendChild(imageContainer);
        if(msg.message && msg.message !== '[Image]'){
          var caption = document.createElement('div');
          caption.className = 'image-caption';
          caption.textContent = msg.message;
          bubble.appendChild(caption);
        }
      }
      // ---- GIF ----
      else if(msg.messageType === 'gif' && msg.gifUrl){
        bubble = document.createElement('div');
        bubble.className = 'chat-bubble gif-message';
        var gifContainer = document.createElement('div');
        gifContainer.className = 'gif-container';
        var maxWidth = 300;
        var displayWidth = msg.gifWidth || maxWidth;
        var displayHeight = msg.gifHeight || 200;
        if(displayWidth > maxWidth){ var ratio = maxWidth / displayWidth; displayWidth = maxWidth; displayHeight = Math.round(displayHeight * ratio); }
        var gifImg = document.createElement('img');
        gifImg.src = msg.gifPreview || msg.gifUrl;
        gifImg.alt = msg.message || 'GIF';
        gifImg.className = 'gif-image';
        gifImg.style.width = displayWidth + 'px';
        gifImg.style.height = displayHeight + 'px';
        gifImg.loading = 'lazy';
        (function(imgEl2, fullUrl, bubbleEl){
          var longPressTimer = null, longPressTriggered = false, touchHandled = false;
          var touchStartX = 0, touchStartY = 0, LONG_PRESS_DURATION = 500, MOVE_THRESHOLD = 10;
          function openLightbox(){ if(fullUrl && UI.openLightbox) UI.openLightbox(fullUrl + '?t=' + Date.now()); }
          function openActionsModal(){ if(bubbleEl.closest('.message-group') && Reactions && Reactions.openPicker) Reactions.openPicker(bubbleEl); }
          function clearLongPress(){ if(longPressTimer){ clearTimeout(longPressTimer); longPressTimer = null; } }
          imgEl2.addEventListener('touchstart', function(e){ longPressTriggered = false; touchHandled = false; touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY; longPressTimer = setTimeout(function(){ longPressTriggered = true; touchHandled = true; if(navigator.vibrate) navigator.vibrate(50); openActionsModal(); }, LONG_PRESS_DURATION); }, { passive: true });
          imgEl2.addEventListener('touchmove', function(e){ var dx = Math.abs(e.touches[0].clientX - touchStartX); var dy = Math.abs(e.touches[0].clientY - touchStartY); if(dx > MOVE_THRESHOLD || dy > MOVE_THRESHOLD) clearLongPress(); }, { passive: true });
          imgEl2.addEventListener('touchend', function(e){ clearLongPress(); if(!longPressTriggered){ touchHandled = true; e.preventDefault(); e.stopPropagation(); openLightbox(); } longPressTriggered = false; });
          imgEl2.addEventListener('touchcancel', function(){ clearLongPress(); longPressTriggered = false; touchHandled = false; });
          imgEl2.addEventListener('click', function(e){ e.stopPropagation(); e.preventDefault(); if(touchHandled){ touchHandled = false; return; } openLightbox(); });
          imgEl2.addEventListener('contextmenu', function(e){ e.preventDefault(); e.stopPropagation(); openActionsModal(); });
        })(gifImg, msg.gifUrl, bubble);
        gifContainer.appendChild(gifImg);
        bubble.appendChild(gifContainer);
        if(msg.message && msg.message !== '[GIF]' && !msg.message.startsWith('[GIF:')){
          var gifCaption = document.createElement('div');
          gifCaption.className = 'gif-caption';
          gifCaption.textContent = msg.message;
          bubble.appendChild(gifCaption);
        }
      }
      // ---- TEXT ----
      else {
        bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        var hasRichLink = this.hasRichLinks(msg.message);
        var isOnlyLink = this.isOnlyRichLink(msg.message);
        if(isOnlyLink) bubble.classList.add('link-only');
        if(!isOnlyLink && msg.message){
          var textSpan = document.createElement('span');
          textSpan.className = 'message-text';
          textSpan.textContent = msg.message;
          bubble.appendChild(textSpan);
        }
        if(hasRichLink && typeof RichLinks !== 'undefined'){
          RichLinks.renderInMessage(bubble, msg.message);
        } else if(!hasRichLink){
          bubble.textContent = msg.message;
        }
      }

      var reactionsContainer = document.createElement('div');
      reactionsContainer.className = 'msg-reactions';
      if(Reactions && Reactions.render) Reactions.render(reactionsContainer, msg.reactions || {}, msg.seq || msg.version);
      group.appendChild(reactionsContainer);
      group.appendChild(bubble);

      var meta = document.createElement('div');
      meta.className = 'message-meta';
      var timeText = document.createElement('span');
      timeText.className = 'meta-time';
      timeText.textContent = this.formatMessageTime(msg.createdAt || msg.updatedAt);
      meta.appendChild(timeText);
      if(this.isMessageEdited(msg)){
        var editedLabel = document.createElement('span');
        editedLabel.className = 'meta-edited';
        editedLabel.textContent = 'Edited';
        meta.appendChild(editedLabel);
      }
      if(isOwnMessage){
        var receiptStatus = this.getReceiptStatus(msg);
        if(receiptStatus){
          var receiptSpan = document.createElement('span');
          receiptSpan.className = 'meta-receipt receipt-' + receiptStatus;
          receiptSpan.textContent = receiptStatus === 'read' ? 'Read' : (receiptStatus === 'delivered' ? 'Delivered' : 'Sent');
          meta.appendChild(receiptSpan);
        }
      }
      group.appendChild(meta);

      if(UI.els.typingIndicator){
        UI.els.chatContainer.insertBefore(group, UI.els.typingIndicator);
      } else {
        UI.els.chatContainer.appendChild(group);
      }

      this.attachMessageClick(bubble);
    }.bind(this));

    // Re-anchor call system messages to bottom (after all real messages)
    callSysMessages.forEach(function(sysEl){
      if(UI.els.typingIndicator){
        UI.els.chatContainer.insertBefore(sysEl, UI.els.typingIndicator);
      } else {
        UI.els.chatContainer.appendChild(sysEl);
      }
    });

    if(wasAtBottom) UI.els.chatContainer.scrollTop = UI.els.chatContainer.scrollHeight;
  },

  attachMessageClick: function(msgEl){
    if(!msgEl || msgEl.__clickAttached) return;
    msgEl.__clickAttached = true;
    msgEl.addEventListener('click', function(e){
      e.stopPropagation();
      if(e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
      if(e.target.classList.contains('reaction-chip') || e.target.closest('.reaction-chip')) return;
      if(e.target.closest('.msg-reactions')) return;
      if(e.target.closest('.reply-bubble')) return;
      if(e.target.closest('.rich-link-preview')) return;
      if(e.target.classList.contains('image-thumbnail') || e.target.classList.contains('gif-image')) return;
      if(e.target.closest('.image-container') || e.target.closest('.gif-container')) return;
      if(e.target.closest('.audio-message')) return;
      var group = msgEl.closest('.message-group');
      if(group && Reactions && Reactions.openPicker) Reactions.openPicker(msgEl);
    });
  },

  enterEditMode: function(seq, currentText){
    this.editingSeq = seq;
    this.exitReplyMode();
    UI.els.reply.value = currentText;
    UI.els.reply.style.height = 'auto';
    UI.els.reply.style.height = Math.min(UI.els.reply.scrollHeight, 100) + 'px';
    UI.els.composeSection.classList.add('editing');
    UI.els.editHeader.classList.add('show');
    UI.els.reply.focus();
  },

  exitEditMode: function(){
    this.editingSeq = null;
    UI.els.reply.value = '';
    UI.els.reply.style.height = 'auto';
    UI.els.composeSection.classList.remove('editing');
    UI.els.editHeader.classList.remove('show');
  },

  handleTyping: function(data){
    var user = data.user;
    var ts = data.ts || Date.now();
    if(!user || user === this.myRole) return;
    if(WebSocketManager.typingTimeouts.has(user)) clearTimeout(WebSocketManager.typingTimeouts.get(user));
    WebSocketManager.typingState.set(user, ts);
    var timeout = setTimeout(function(){
      WebSocketManager.typingState.delete(user);
      WebSocketManager.typingTimeouts.delete(user);
      this.renderTypingIndicator();
    }.bind(this), 5000);
    WebSocketManager.typingTimeouts.set(user, timeout);
    this.renderTypingIndicator();
  },

  renderTypingIndicator: function(){
    if(!UI.els.typingIndicator) return;
    var now = Date.now();
    var activeUsers = [];
    for(var entry of Array.from(WebSocketManager.typingState.entries())){
      var user = entry[0]; var ts = entry[1];
      if(now - ts > 5000){
        WebSocketManager.typingState.delete(user);
        if(WebSocketManager.typingTimeouts.has(user)){ clearTimeout(WebSocketManager.typingTimeouts.get(user)); WebSocketManager.typingTimeouts.delete(user); }
      } else if(user !== this.myRole){ activeUsers.push(user); }
    }
    if(activeUsers.length > 0){
      UI.els.typingIndicator.classList.add('show');
      if(UI.els.chatContainer) UI.els.chatContainer.scrollTop = UI.els.chatContainer.scrollHeight;
    } else {
      UI.els.typingIndicator.classList.remove('show');
    }
  }
};
