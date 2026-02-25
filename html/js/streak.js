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

  _playMilestone: function(streak){
    var container = document.getElementById('chatContainer');
    if(!container) return;
    var cycle = (streak % 20) / 5; // 1,2,3,0
    console.log('[Streak] Milestone ' + streak + '! Effect cycle:', cycle);
    if(cycle === 1) this._confetti(container);
    else if(cycle === 2) this._emojiRain(container);
    else if(cycle === 3) this._shimmer(container);
    else this._sparkle(container);
  },

  _confetti: function(container){
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
      container.appendChild(el);
      (function(e){ setTimeout(function(){ e.remove(); }, 2200); })(el);
    }
  },

  _emojiRain: function(container){
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

  _shimmer: function(container){
    container.classList.add('chat-celebrate-shimmer');
    setTimeout(function(){ container.classList.remove('chat-celebrate-shimmer'); }, 2000);
  },

  _sparkle: function(container){
    var cx = container.offsetWidth / 2;
    var cy = container.offsetHeight / 2;
    for(var i = 0; i < 20; i++){
      var el = document.createElement('span');
      el.className = 'celebrate-sparkle';
      var angle = (Math.PI * 2 * i) / 20;
      var dist = 60 + Math.random() * 80;
      el.style.setProperty('--tx', Math.cos(angle) * dist + 'px');
      el.style.setProperty('--ty', Math.sin(angle) * dist + 'px');
      el.style.left = cx + 'px';
      el.style.top = cy + 'px';
      el.style.animationDelay = (Math.random() * 0.2) + 's';
      container.appendChild(el);
      (function(e){ setTimeout(function(){ e.remove(); }, 1600); })(el);
    }
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
