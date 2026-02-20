// Path: html/js/messages.js
// ============================================================================
// MESSAGES.JS - v4: Added audio message rendering + call system messages
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

  // Format seconds (for call duration)
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
  // These are ephemeral DOM elements — they appear in chat during/after a call
  // but are NOT persisted to the DB. They survive until the next full render().
  // =========================================================================

  // Inject a new call system message into the chat.
  // opts: { id, role, status, isCaller }
  //   id       - unique id for this call (used to find + update later)
  //   role     - caller's role label ('E' or 'M')
  //   status   - 'calling' | 'incoming' | 'connecting' | 'connected' | 'ended' | 'missed' | 'declined' | 'disconnected'
  //   isCaller - true if we are the one who started the call
  injectCallMessage: function(opts){
    var container = UI.els.chatContainer;
    if(!container) return;

    // Remove any existing call message with the same id
    var existing = document.getElementById('call-sys-' + opts.id);
    if(existing) existing.remove();

    var el = document.createElement('div');
    el.id = 'call-sys-' + opts.id;
    el.className = 'call-system-message';
    el.setAttribute('data-caller', opts.role || '');
    el.setAttribute('data-is-caller', opts.isCaller ? 'true' : 'false');

    this._renderCallContent(el, opts.role, opts.status, opts.isCaller, 0);

    // Insert before typing indicator so it stays at bottom
    if(UI.els.typingIndicator){
      container.insertBefore(el, UI.els.typingIndicator);
    } else {
      container.appendChild(el);
    }
    container.scrollTop = container.scrollHeight;
  },

  // Update an existing call system message by id.
  updateCallMessage: function(id, status, duration){
    var el = document.getElementById('call-sys-' + id);
    if(!el) return;
    var role     = el.getAttribute('data-caller');
    var isCaller = el.getAttribute('data-is-caller') === 'true';
    this._renderCallContent(el, role, status, isCaller, duration || 0);
    var container = UI.els.chatContainer;
    if(container) container.scrollTop = container.scrollHeight;
  },

  // Build the inner HTML for a call system message.
  _renderCallContent: function(el, role, status, isCaller, duration){
    el.innerHTML = '';

    var callerName = role || '?';
    var iconEl = document.createElement('span');
    iconEl.className = 'call-sys-icon';
    var textEl = document.createElement('span');
    textEl.className = 'call-sys-text';
    var meta = document.createElement('span');
    meta.className = 'call-sys-time';
    meta.textContent = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    // Status-specific content
    switch(status){
      case 'calling':
        el.setAttribute('data-state', 'active');
        iconEl.textContent = '📹';
        textEl.textContent = isCaller ? 'Calling ' + (isCaller ? (role === 'M' ? 'M' : 'M') : callerName) + '...' : callerName + ' is calling...';
        // Pulse animation hint
        iconEl.classList.add('pulse');
        break;

      case 'incoming':
        el.setAttribute('data-state', 'active');
        iconEl.textContent = '📲';
        textEl.textContent = callerName + ' is calling...';
        iconEl.classList.add('pulse');
        // Answer + Decline buttons
        var answerBtn = document.createElement('button');
        answerBtn.className = 'call-answer-btn';
        answerBtn.textContent = 'Answer';
        answerBtn.onclick = function(e){
          e.stopPropagation();
          if(typeof VideoChat !== 'undefined') VideoChat._answerCall();
        };
        var declineBtn = document.createElement('button');
        declineBtn.className = 'call-decline-btn';
        declineBtn.textContent = 'Decline';
        declineBtn.onclick = function(e){
          e.stopPropagation();
          if(typeof VideoChat !== 'undefined') VideoChat._declineCall();
        };
        el.appendChild(iconEl);
        el.appendChild(textEl);
        el.appendChild(answerBtn);
        el.appendChild(declineBtn);
        el.appendChild(meta);
        return; // early — already appended all children

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
  // AUDIO BUBBLE
  // =========================================================================

  _buildAudioBubble: function(msg, isOwn){
    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble audio-message';

    var duration = this.formatAudioDuration(msg.audioDuration);
    var audioUrl = msg.audioUrl || (msg.imageUrl) || null;

    var waveContainer = document.createElement('div');
    waveContainer.className = 'audio-waveform';
    var barCount = 20;
    for(var i = 0; i < barCount; i++){
      var bar = document.createElement('span');
      bar.className = 'audio-bar';
      var seed = ((msg.seq || 1) * 31 + i * 17) % 100;
      var h = 20 + (seed % 60);
      bar.style.height = h + '%';
      waveContainer.appendChild(bar);
    }

    var playBtn = document.createElement('button');
    playBtn.className = 'audio-play-btn';
    playBtn.setAttribute('aria-label', 'Play voice message');
    playBtn.setAttribute('type', 'button');
    playBtn.innerHTML = '<svg class="play-icon" viewBox="0 0 24 24" width="18" height="18"><polygon points="5,3 19,12 5,21" fill="currentColor"/></svg>' +
                        '<svg class="pause-icon" viewBox="0 0 24 24" width="18" height="18"><rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/></svg>';

    var durLabel = document.createElement('span');
    durLabel.className = 'audio-duration';
    durLabel.textContent = duration;

    bubble.appendChild(playBtn);
    bubble.appendChild(waveContainer);
    bubble.appendChild(durLabel);

    if(audioUrl){
      (function(btn, url, dLabel, waveEl, msgSeq){
        var audioEl = null;
        var totalBars = waveEl.querySelectorAll('.audio-bar').length;

        btn.addEventListener('click', function(e){
          e.stopPropagation();

          if(!audioEl){
            audioEl = new window.Audio(url);
            audioEl.addEventListener('timeupdate', function(){
              var pct = audioEl.duration ? audioEl.currentTime / audioEl.duration : 0;
              var filled = Math.round(pct * totalBars);
              var bars = waveEl.querySelectorAll('.audio-bar');
              bars.forEach(function(b, i){ b.classList.toggle('played', i < filled); });
              var remaining = audioEl.duration ? audioEl.duration - audioEl.currentTime : 0;
              var rs = Math.round(remaining);
              var rm = Math.floor(rs / 60); rs = rs % 60;
              dLabel.textContent = rm + ':' + (rs < 10 ? '0' : '') + rs;
            });
            audioEl.addEventListener('ended', function(){
              btn.classList.remove('playing');
              var bars = waveEl.querySelectorAll('.audio-bar');
              bars.forEach(function(b){ b.classList.remove('played'); });
              if(typeof Messages !== 'undefined'){
                var origMsg = Messages.findMessageBySeq(msgSeq);
                if(origMsg) dLabel.textContent = Messages.formatAudioDuration(origMsg.audioDuration);
              }
            });
            audioEl.addEventListener('error', function(){
              btn.classList.remove('playing');
              console.error('[Audio] Playback error for:', url);
            });
          }

          if(!audioEl.paused){
            audioEl.pause();
            btn.classList.remove('playing');
          } else {
            document.querySelectorAll('.audio-play-btn.playing').forEach(function(b){
              b.classList.remove('playing');
              if(b._audioEl) b._audioEl.pause();
            });
            btn._audioEl = audioEl;
            audioEl.play().then(function(){
              btn.classList.add('playing');
            }).catch(function(err){
              console.error('[Audio] Play failed:', err);
            });
          }
        });
      })(playBtn, audioUrl, durLabel, waveContainer, msg.seq);
    } else {
      playBtn.disabled = true;
      playBtn.style.opacity = '0.4';
    }

    return bubble;
  },

  // =========================================================================
  // RENDER
  // =========================================================================

  render: function(){
    if(!UI.els.chatContainer) return;
    var wasAtBottom = UI.els.chatContainer.scrollHeight - UI.els.chatContainer.scrollTop <= UI.els.chatContainer.clientHeight + 50;

    // Remove regular message groups but KEEP call system messages
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

      // Reactions
      var reactionsContainer = document.createElement('div');
      reactionsContainer.className = 'msg-reactions';
      if(Reactions && Reactions.render) Reactions.render(reactionsContainer, msg.reactions || {}, msg.seq || msg.version);
      group.appendChild(reactionsContainer);
      group.appendChild(bubble);

      // Meta
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

      // Insert before typing indicator
      if(UI.els.typingIndicator){
        UI.els.chatContainer.insertBefore(group, UI.els.typingIndicator);
      } else {
        UI.els.chatContainer.appendChild(group);
      }

      this.attachMessageClick(bubble);
    }.bind(this));

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
