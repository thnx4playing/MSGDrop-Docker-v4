// Image handling
var Images = {
  list: [],
  _lastCelebratedCount: 0,

  fetch: async function(dropId, force){
    try{
      var data = await API.fetchImages(dropId, force);
      if(!data) return;
      var raw = (data && data.images) || [];
      this.list = raw.map(function(im){
        return {
          id: im.imageId,
          urls: { thumb: im.thumbUrl, original: im.originalUrl },
          uploadedAt: im.uploadedAt
        };
      });
      // Sync milestone tracker so existing photos don't re-trigger celebrations
      var highestMilestone = Math.floor(this.list.length / 5) * 5;
      if(highestMilestone > this._lastCelebratedCount) this._lastCelebratedCount = highestMilestone;
      this.render();
    }catch(e){
      console.error('fetchImages error:', e);
    }
  },

  render: function(){
    var thumbContainer = document.getElementById('thumbStrip');
    if(!thumbContainer) return;

    this.updateBadge();

    if(this.list.length === 0){
      if(UI.els.thumbEmpty) UI.els.thumbEmpty.classList.add('show');
      thumbContainer.innerHTML = '';
      thumbContainer.appendChild(UI.els.thumbEmpty || document.getElementById('thumbEmpty'));
      return;
    }

    if(UI.els.thumbEmpty) UI.els.thumbEmpty.classList.remove('show');

    // Already sorted newest-first from server; just render in order
    var frag = document.createDocumentFragment();
    this.list.forEach(function(im){
      var div=document.createElement('div');
      div.className='thumb-item';

      var img = document.createElement('img');
      img.className = 'thumb-img';
      var thumbUrl = im.urls && im.urls.thumb;
      if(thumbUrl){
        img.src = thumbUrl + '?t=' + Date.now();
      }
      img.alt = 'Photo';
      img.loading = 'lazy';
      div.appendChild(img);

      div.setAttribute('role','button');
      div.setAttribute('tabindex','0');
      div.setAttribute('aria-label','Open image');

      var trash=document.createElement('button');
      trash.type='button';
      trash.className='thumb-delete';
      trash.setAttribute('aria-label','Delete image');
      trash.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6 L18 18 M18 6 L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      div.appendChild(trash);

      div.addEventListener('click', function(e){
        if(e.target===trash || trash.contains(e.target)) return;
        var originalUrl = (im.urls && im.urls.original) || (im.urls && im.urls.thumb) || '';
        if(originalUrl){
          originalUrl += '?t=' + Date.now();
        }
        UI.openLightbox(originalUrl);
      });

      trash.addEventListener('click', function(e){
        e.stopPropagation();
        e.preventDefault();
        if(confirm('Delete this photo?')) {
          this.delete(im.id);
        }
      }.bind(this));

      frag.appendChild(div);
    }.bind(this));
    thumbContainer.innerHTML='';
    thumbContainer.appendChild(frag);
  },

  updateBadge: function(){
    var count = this.list.length;
    if(UI.els.imageCountBadge){
      UI.els.imageCountBadge.textContent = count > 0 ? count : '';
    }
    // Update count in modal header
    var thumbCount = document.getElementById('thumbCount');
    if(thumbCount){
      thumbCount.textContent = count > 0 ? count + (count === 1 ? ' Photo' : ' Photos') : '';
    }
  },

  delete: async function(imageId){
    var dropId = encodeURIComponent(App.dropId);
    var maxRetries = 2;
    var retryDelay = 500;

    for(var attempt = 0; attempt <= maxRetries; attempt++){
      try{
        var res = await API.deleteImage(dropId, imageId);

        if(res.ok){
          var data = await res.json().catch(function(){ return null; });
          if (data && Array.isArray(data.images)) {
            this.list = data.images.map(function(im){
              return {
                id: im.imageId,
                urls: { thumb: im.thumbUrl, original: im.originalUrl },
                uploadedAt: im.uploadedAt
              };
            });
            this.render();
          } else {
            setTimeout(function(){ this.fetch(dropId).catch(function(){}); }.bind(this), 250);
          }
          return;
        }

        if(attempt < maxRetries){
          console.log('[Images] Delete failed with status ' + res.status + ', retrying in ' + retryDelay + 'ms (attempt ' + (attempt + 1) + ')');
          await new Promise(function(resolve){ setTimeout(resolve, retryDelay); });
          retryDelay *= 2;
          continue;
        }

        alert('Delete failed: ' + res.status);
        return;

      }catch(e){
        if(attempt < maxRetries){
          console.log('[Images] Network error deleting image, retrying in ' + retryDelay + 'ms (attempt ' + (attempt + 1) + ')');
          await new Promise(function(resolve){ setTimeout(resolve, retryDelay); });
          retryDelay *= 2;
          continue;
        }

        alert('Delete failed (network error after ' + (maxRetries + 1) + ' attempts)');
        return;
      }
    }
  },

  upload: async function(file){
    this.showUploadStatus('Uploading image...');
    try{
      var dropId = encodeURIComponent(App.dropId);
      var oldCount = this.list.length;
      var res = await API.uploadImage(dropId, file);
      if(res && res.messages){
        Messages.applyDrop(res);
      }
      if(res && res.images){
        Images.list = res.images.map(function(im){
          return { id: im.imageId, urls: { thumb: im.thumbUrl, original: im.originalUrl }, uploadedAt: im.uploadedAt };
        });
        Images.render();
        this.checkMilestone(oldCount, this.list.length);
      }
      this.hideUploadStatus();
      setTimeout(function(){ if(UI.els.chatContainer){ UI.els.chatContainer.scrollTop = UI.els.chatContainer.scrollHeight; } }, 100);
    }catch(err){
      console.error('Upload error:', err);
      this.showUploadStatus('Upload failed', true);
      setTimeout(function(){ this.hideUploadStatus(); }.bind(this), 3000);
      alert('Upload failed: ' + (err.message || err));
    }
  },

  showUploadStatus: function(message, isError){
    var toast = document.getElementById('uploadToast');
    if(!toast){
      toast = document.createElement('div');
      toast.id = 'uploadToast';
      toast.className = 'upload-toast';
      document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.className = 'upload-toast show' + (isError ? ' error' : '');
  },

  hideUploadStatus: function(){
    var toast = document.getElementById('uploadToast');
    if(toast){
      toast.classList.remove('show');
    }
  },

  checkMilestone: function(oldCount, newCount){
    // Find the first milestone crossed between oldCount and newCount
    var milestone = 0;
    for(var m = oldCount + 1; m <= newCount; m++){
      if(m > 0 && m % 5 === 0){ milestone = m; break; }
    }
    if(!milestone || milestone <= this._lastCelebratedCount) return;
    this._lastCelebratedCount = milestone;

    // Open modal if not already visible
    var modal = document.getElementById('thumbSection');
    if(modal && !modal.classList.contains('show')){
      UI.showThumbModal();
    }

    // Pick effect based on cycle: 5→confetti, 10→emoji, 15→shimmer, 20→sparkle
    var cycle = (milestone % 20) / 5; // 1,2,3,0
    if(cycle === 1) this._confetti(modal);
    else if(cycle === 2) this._emojiRain(modal);
    else if(cycle === 3) this._shimmer(modal);
    else this._sparkle(modal);
  },

  _confetti: function(container){
    if(!container) return;
    var colors = ['#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#ff6ed4','#a855f7'];
    var shapes = ['circle','square'];
    for(var i = 0; i < 30; i++){
      var el = document.createElement('span');
      el.className = 'celebrate-particle';
      el.style.left = (Math.random() * 100) + '%';
      el.style.animationDelay = (Math.random() * 0.6) + 's';
      el.style.background = colors[Math.floor(Math.random() * colors.length)];
      if(shapes[Math.floor(Math.random() * 2)] === 'circle') el.style.borderRadius = '50%';
      el.style.width = (6 + Math.random() * 6) + 'px';
      el.style.height = el.style.width;
      container.appendChild(el);
      (function(e){ setTimeout(function(){ e.remove(); }, 2200); })(el);
    }
  },

  _emojiRain: function(container){
    if(!container) return;
    var emojis = ['\uD83D\uDCF8','\uD83C\uDF1F','\uD83C\uDF89','\uD83D\uDC96','\uD83D\uDD25','\uD83C\uDF08','\u2728','\uD83C\uDF1E','\uD83C\uDFA8'];
    for(var i = 0; i < 15; i++){
      var el = document.createElement('span');
      el.className = 'celebrate-emoji';
      el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      el.style.left = (Math.random() * 90 + 5) + '%';
      el.style.animationDelay = (Math.random() * 0.8) + 's';
      container.appendChild(el);
      (function(e){ setTimeout(function(){ e.remove(); }, 2800); })(el);
    }
  },

  _shimmer: function(modal){
    if(!modal) return;
    modal.classList.add('thumb-celebrate-shimmer');
    setTimeout(function(){ modal.classList.remove('thumb-celebrate-shimmer'); }, 2000);
  },

  _sparkle: function(container){
    if(!container) return;
    var badge = container.querySelector('.thumb-count') || container.querySelector('.thumb-header');
    var rect = badge ? badge.getBoundingClientRect() : null;
    var cRect = container.getBoundingClientRect();
    var cx = rect ? (rect.left + rect.width / 2 - cRect.left) : cRect.width / 2;
    var cy = rect ? (rect.top + rect.height / 2 - cRect.top) : 40;
    for(var i = 0; i < 20; i++){
      var el = document.createElement('span');
      el.className = 'celebrate-sparkle';
      var angle = (Math.PI * 2 * i) / 20;
      var dist = 40 + Math.random() * 50;
      el.style.setProperty('--tx', Math.cos(angle) * dist + 'px');
      el.style.setProperty('--ty', Math.sin(angle) * dist + 'px');
      el.style.left = cx + 'px';
      el.style.top = cy + 'px';
      el.style.animationDelay = (Math.random() * 0.2) + 's';
      container.appendChild(el);
      (function(e){ setTimeout(function(){ e.remove(); }, 1600); })(el);
    }
  },

  makeThumb: function(file, max){
    return new Promise(function(resolve,reject){
      var url=URL.createObjectURL(file);
      var img=new Image();
      img.onload=function(){
        var s=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
        var w=Math.max(1,Math.round(img.naturalWidth*s));
        var h=Math.max(1,Math.round(img.naturalHeight*s));

        var c=document.createElement('canvas');
        c.width=w;
        c.height=h;
        var ctx=c.getContext('2d', { alpha: false });

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img,0,0,w,h);

        URL.revokeObjectURL(url);

        c.toBlob(function(b){
          if(b){
            resolve(b);
          } else {
            reject(new Error('Thumb toBlob failed'));
          }
        }, 'image/jpeg', 0.92);
      };
      img.onerror=function(e){
        URL.revokeObjectURL(url);
        reject(e);
      };
      img.src=url;
    });
  }
};
