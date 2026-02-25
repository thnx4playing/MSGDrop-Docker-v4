// API utilities
var API = {
  // No more passcode - authentication via cookies now
  
  bust: function(url){
    var u;
    try{ u = new URL(url, location.origin); }catch(e){ return url; }
    u.searchParams.set('t', String(Date.now()));
    return u.toString();
  },

  api: function(path, opts){
    var base = CONFIG.API_BASE_URL.replace(/\/$/,'');
    var headers = (opts && opts.headers) ? Object.assign({}, opts.headers) : {};
    // No X-Passcode header - using session cookies instead
    var url = base + path;
    // IMPORTANT: credentials: 'include' sends cookies automatically
    return fetch(url, Object.assign({}, opts, { headers: headers, credentials: 'include' }));
  },

  fetchDrop: async function(dropId){
    // ⚡ OPTIMIZED: This now returns BOTH messages AND images in one call!
    // Response format: { dropId, version, messages, activeCall, images: [...] }
    // Updated endpoint from /drop3/ to /chat/
    var url = this.bust(CONFIG.API_BASE_URL.replace(/\/$/,'') + '/chat/' + dropId);
    var res = await fetch(url, { 
      method:'GET', 
      credentials:'include'  // Send session cookie
    });
    if (!res.ok){ 
      if(res.status === 403 || res.status === 401) {
        // Session expired - redirect to unlock
        var nextUrl = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = '/unlock/?next=' + nextUrl;
        throw new Error('AUTH_REQUIRED');
      }
      throw new Error('HTTP '+res.status);
    }
    return await res.json();
  },

  fetchImages: async function(dropId, force){
    var url = this.bust(CONFIG.API_BASE_URL.replace(/\/$/,'') + '/chat/' + dropId + '/images');
    var res = await fetch(url, { method:'GET', credentials:'include' });
    if(!res.ok){
      if(res.status === 403 || res.status === 401){
        var nextUrl = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = '/unlock/?next=' + nextUrl;
        throw new Error('AUTH_REQUIRED');
      }
      throw new Error('HTTP '+res.status);
    }
    return await res.json();
  },

  postMessage: async function(dropId, text, prevVersion, user, clientId, replyToSeq){
    // If replyToSeq is provided, use JSON body instead of FormData
    if(replyToSeq){
      return await fetch(CONFIG.API_BASE_URL.replace(/\/$/,'') + '/chat/'+dropId, {
        method:'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          text: text,
          user: user,
          replyToSeq: replyToSeq
        })
      });
    }
    
    // Original FormData approach for non-reply messages
    var fd = new FormData();
    if(text != null) fd.append('text_', text);
    if(user) fd.append('user', user);
    return await fetch(CONFIG.API_BASE_URL.replace(/\/$/,'') + '/chat/'+dropId, {
      method:'POST',
      body: fd,
      credentials: 'include'
    });
  },

  editMessage: async function(dropId, seq, text){
    // Updated endpoint from /drop3/ to /chat/
    return await this.api('/chat/' + dropId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq: seq, text: text })
    });
  },

  deleteMessage: async function(dropId, seq){
    // Updated endpoint from /drop3/ to /chat/
    return await this.api('/chat/' + dropId, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq: seq })
    });
  },

  reactToMessage: async function(dropId, seq, emoji, op){
    // Updated endpoint from /drop3/ to /chat/
    return await this.api('/chat/' + dropId + '/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seq: seq, emoji: emoji, op: op || 'add' })
    });
  },

  uploadImage: async function(dropId, file){
    var fd = new FormData();
    fd.append('file', file);
    // Add user field so backend knows who uploaded the image
    var userRole = App.myRole || Storage.getRole(dropId) || 'E';
    fd.append('user', userRole);
    var res = await fetch(CONFIG.API_BASE_URL.replace(/\/$/,'') + '/chat/'+dropId, {
      method:'POST',
      body: fd,
      credentials: 'include'
    });
    if(!res.ok) throw new Error('Upload failed: '+res.status);
    return await res.json();
  },

  deleteImage: async function(dropId, imageId){
    // Updated endpoint from /drop3/ to /chat/ and updated to match API spec
    return await this.api('/chat/'+dropId+'/images/' + imageId, {
      method: 'DELETE'
    });
  },

  fetchStreak: async function(dropId){
    // FIXED: Updated to /api/chat/{dropId}/streak
    var url = CONFIG.API_BASE_URL.replace(/\/$/,'') + '/chat/' + dropId + '/streak';
    var res = await fetch(url, { 
      method:'GET', 
      credentials:'include'
    });
    if(!res.ok){
      if(res.status === 403 || res.status === 401){
        var nextUrl = encodeURIComponent(window.location.pathname + window.location.search);
        window.location.href = '/unlock/?next=' + nextUrl;
        throw new Error('AUTH_REQUIRED');
      }
      console.error('fetchStreak failed:', res.status, res.statusText);
      throw new Error('HTTP '+res.status);
    }
    return await res.json();
  },

  // Deprecated - streaks now update automatically
  // Kept for backwards compatibility
  updateStreak: async function(dropId, user){
    return await this.api('/chat/' + dropId + '/streak', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
