// Image handling
var Images = {
  list: [],

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
      var res = await API.uploadImage(dropId, file);
      if(res && res.messages){
        Messages.applyDrop(res);
      }
      if(res && res.images){
        Images.list = res.images.map(function(im){
          return { id: im.imageId, urls: { thumb: im.thumbUrl, original: im.originalUrl }, uploadedAt: im.uploadedAt };
        });
        Images.render();
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
