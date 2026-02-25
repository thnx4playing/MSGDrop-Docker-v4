// Streak tracking - Simplified Design
var Streak = {
  currentStreak: 0,
  bothPostedToday: false,
  mPostedToday: false,
  ePostedToday: false,
  lastFetchTime: 0,

  // Storage key for this drop
  getStorageKey: function(){
    var dropId = 'default';
    try {
      dropId = new URL(window.location.href).searchParams.get('drop') || 'default';
    } catch(e){}
    return 'streak_' + dropId;
  },

  // Get last known state from localStorage
  getStoredState: function(){
    try {
      var stored = localStorage.getItem(this.getStorageKey());
      if(stored){
        return JSON.parse(stored);
      }
    } catch(e){}
    return null;
  },

  // Save current state to localStorage
  saveState: function(){
    try {
      localStorage.setItem(this.getStorageKey(), JSON.stringify({
        streak: this.currentStreak,
        date: new Date().toISOString().split('T')[0]
      }));
    } catch(e){}
  },

  // Mark that we've shown the broken animation
  markBrokenAnimationShown: function(){
    try {
      var state = this.getStoredState() || {};
      state.brokenAnimationShown = true;
      localStorage.setItem(this.getStorageKey(), JSON.stringify(state));
    } catch(e){}
  },

  // Check if broken animation was already shown
  wasBrokenAnimationShown: function(){
    var state = this.getStoredState();
    return state && state.brokenAnimationShown === true;
  },

  // Clear broken animation flag (when streak increases)
  clearBrokenAnimationFlag: function(){
    try {
      var state = this.getStoredState() || {};
      delete state.brokenAnimationShown;
      localStorage.setItem(this.getStorageKey(), JSON.stringify(state));
    } catch(e){}
  },

  fetch: async function(dropId){
    try {
      var data = await API.fetchStreak(dropId);
      
      if(!data) {
        console.warn('[Streak] No data received');
        return;
      }
      
      this.handleUpdate(data, true);
      this.lastFetchTime = Date.now();
    } catch(e){
      console.error('[Streak] Fetch error:', e);
    }
  },

  handleWebSocketUpdate: function(data){
    console.log('[Streak] WebSocket update:', data);
    this.handleUpdate(data, false);
  },

  handleUpdate: function(data, isInitialLoad){
    var storedState = this.getStoredState();
    var oldStreak = storedState ? storedState.streak : 0;
    var serverStreak = data.streak || 0;
    
    console.log('[Streak] Update - Stored:', oldStreak, 'Server:', serverStreak, 'Initial:', isInitialLoad);
    
    // Update local state
    this.currentStreak = serverStreak;
    this.bothPostedToday = data.bothPostedToday || false;
    this.mPostedToday = data.mPostedToday || false;
    this.ePostedToday = data.ePostedToday || false;
    
    // Render first
    this.render();
    
    // Handle animations
    
    // Case 1: Server says streak broke (from API response)
    if(data.brokeStreak && data.previousStreak > 0){
      console.log('[Streak] Server indicated streak broke from', data.previousStreak);
      this.showBroken(data.previousStreak);
      this.saveState();
      return;
    }
    
    // Case 2: On initial load, compare stored vs server
    if(isInitialLoad && storedState){
      // Streak broke while we were away
      if(serverStreak === 0 && oldStreak > 0 && !this.wasBrokenAnimationShown()){
        console.log('[Streak] Detected broken streak on load:', oldStreak, '→ 0');
        this.showBroken(oldStreak);
        this.markBrokenAnimationShown();
        this.saveState();
        return;
      }
      
      // Streak increased while we were away (unlikely but possible)
      if(serverStreak > oldStreak && oldStreak > 0){
        console.log('[Streak] Streak increased while away:', oldStreak, '→', serverStreak);
        this.celebrate();
        this.clearBrokenAnimationFlag();
      }
    }
    
    // Case 3: Live update - streak increased
    if(!isInitialLoad && serverStreak > oldStreak){
      console.log('[Streak] Live streak increase:', oldStreak, '→', serverStreak);
      this.celebrate();
      this.clearBrokenAnimationFlag();
    }
    
    // Save current state
    this.saveState();
  },

  render: function(){
    var countEl = document.getElementById('streakCount');
    if(!countEl) return;
    
    countEl.textContent = this.currentStreak;
    
    var display = document.getElementById('streakDisplay');
    if(!display) return;
    
    // Pulse effect when both posted today
    if(this.bothPostedToday && this.currentStreak > 0){
      display.classList.add('streak-complete');
    } else {
      display.classList.remove('streak-complete');
    }
  },

  celebrate: function(){
    var display = document.getElementById('streakDisplay');
    if(!display) return;

    if(this.celebrateTimeout) clearTimeout(this.celebrateTimeout);

    display.classList.remove('streak-celebrate', 'streak-complete', 'streak-bounce', 'streak-broken');
    void display.offsetWidth; // Force reflow

    display.classList.add('streak-celebrate');
    console.log('[Streak] 🎉 Celebration animation!');

    this.celebrateTimeout = setTimeout(function(){
      display.classList.remove('streak-celebrate');
    }, 1000);

    // Milestone celebration every 5 days
    if(this.currentStreak > 0 && this.currentStreak % 5 === 0){
      this._playMilestone(this.currentStreak);
    }
  },

  // Fire color palette (37 entries: black → red → orange → yellow → white)
  _firePalette: (function(){
    var p = [];
    for(var i = 0; i < 37; i++){
      if(i === 0){ p.push([0,0,0,0]); }
      else if(i < 12){ p.push([Math.min(255, i * 25), 0, 0, 255]); }
      else if(i < 24){ p.push([255, Math.min(255, (i - 12) * 22), 0, 255]); }
      else { p.push([255, 255, Math.min(255, (i - 24) * 20), 255]); }
    }
    return p;
  })(),

  _playMilestone: function(streak){
    var chat = document.getElementById('chatContainer');
    if(!chat) return;
    console.log('[Streak] Milestone ' + streak + '! Confetti + fire');

    // Create a fixed overlay matching the chat area
    var rect = chat.getBoundingClientRect();
    var overlay = document.createElement('div');
    overlay.className = 'celebrate-overlay';
    overlay.style.top = rect.top + 'px';
    overlay.style.left = rect.left + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    document.body.appendChild(overlay);

    // Confetti
    var colors = ['#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#ff6ed4','#a855f7'];
    for(var i = 0; i < 30; i++){
      var el = document.createElement('span');
      el.className = 'celebrate-particle';
      el.style.left = (Math.random() * 100) + '%';
      el.style.animationDelay = (Math.random() * 0.6) + 's';
      el.style.background = colors[Math.floor(Math.random() * colors.length)];
      if(Math.random() > 0.5) el.style.borderRadius = '50%';
      el.style.width = (6 + Math.random() * 6) + 'px';
      el.style.height = el.style.width;
      overlay.appendChild(el);
    }

    // Fire + streak count container
    var flame = document.createElement('div');
    flame.className = 'celebrate-flame';

    // Canvas fire simulation
    var fw = 50, fh = 70;
    var canvas = document.createElement('canvas');
    canvas.width = fw;
    canvas.height = fh;
    canvas.className = 'celebrate-fire-canvas';
    flame.appendChild(canvas);

    // Glow layer behind canvas
    var glow = document.createElement('div');
    glow.className = 'celebrate-flame-glow';
    flame.appendChild(glow);

    // Streak number
    var countEl = document.createElement('span');
    countEl.className = 'celebrate-flame-count';
    countEl.textContent = streak;
    flame.appendChild(countEl);

    overlay.appendChild(flame);

    // Fire simulation
    var ctx = canvas.getContext('2d');
    var pixels = new Uint8Array(fw * fh);
    var imgData = ctx.createImageData(fw, fh);
    var palette = this._firePalette;
    var running = true;

    // Ignite bottom row
    for(var x = 0; x < fw; x++){
      pixels[(fh - 1) * fw + x] = 36;
    }

    function tick(){
      if(!running) return;
      // Spread fire upward
      for(var y = 0; y < fh - 1; y++){
        for(var x = 0; x < fw; x++){
          var src = (y + 1) * fw + x;
          var decay = (Math.random() * 3.5) | 0;
          var nx = x - decay + 1;
          if(nx < 0) nx = 0;
          if(nx >= fw) nx = fw - 1;
          pixels[y * fw + nx] = Math.max(0, pixels[src] - (decay & 1));
        }
      }
      // Render pixels
      var d = imgData.data;
      for(var i = 0; i < pixels.length; i++){
        var c = palette[pixels[i]];
        var p = i * 4;
        d[p] = c[0]; d[p+1] = c[1]; d[p+2] = c[2]; d[p+3] = c[3];
      }
      ctx.putImageData(imgData, 0, 0);
      requestAnimationFrame(tick);
    }
    tick();

    setTimeout(function(){
      running = false;
      overlay.remove();
    }, 2600);
  },

  showBroken: function(lostStreak){
    var display = document.getElementById('streakDisplay');
    if(!display) return;
    
    if(this.brokenTimeout) clearTimeout(this.brokenTimeout);
    
    display.classList.remove('streak-celebrate', 'streak-complete', 'streak-bounce', 'streak-broken');
    void display.offsetWidth; // Force reflow
    
    display.classList.add('streak-broken');
    console.log('[Streak] 💔 Broken animation! Lost', lostStreak, 'day streak');
    
    this.brokenTimeout = setTimeout(function(){
      display.classList.remove('streak-broken');
    }, 1500);
  },

  refresh: async function(dropId){
    var now = Date.now();
    if(now - this.lastFetchTime < 5000) {
      console.log('[Streak] Throttled refresh');
      return;
    }
    await this.fetch(dropId);
  }
};
