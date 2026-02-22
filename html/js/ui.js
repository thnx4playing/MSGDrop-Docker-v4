// UI utilities and helpers
var UI = {
  els: {},

  init: function(){
    this.els = {
      chatContainer: document.getElementById('chatContainer'),
      reply: document.getElementById('reply'),
      postBtn: document.getElementById('postBtn'),
      liveStatus: document.getElementById('liveStatus'),
      uploadBtn: document.getElementById('uploadBtn'),
      fileInput: document.getElementById('fileInput'),
      thumbModalOverlay: document.getElementById('thumbSection'),
      thumbGrid: document.getElementById('thumbStrip'),
      thumbEmpty: document.getElementById('thumbEmpty'),
      thumbOverlay: document.getElementById('thumbOverlay'),
      lightbox: document.getElementById('lightbox'),
      lightboxImg: document.getElementById('lightboxImg'),
      lbCloseCenter: document.getElementById('lbCloseCenter'),
      lbLoading: document.getElementById('lbLoading'),
      themeToggle: document.getElementById('themeToggle'),
      emojiBtn: document.getElementById('emojiBtn'),
      emojiPopover: document.getElementById('emojiPopover'),
      emojiGrid: document.getElementById('emojiGrid'),
      libraryBtn: document.getElementById('libraryBtn'),
      imageCountBadge: document.getElementById('imageCountBadge'),
      thumbCloseBtn: document.getElementById('thumbCloseBtn'),
      composeTimer: document.getElementById('composeTimer'),
      composeSection: document.getElementById('composeSection'),
      editHeader: document.getElementById('editHeader'),
      cancelEditBtn: document.getElementById('cancelEditBtn'),
      reactPicker: document.getElementById('reactPicker'),
      userBtn: document.getElementById('userBtn'),
      userRoleModal: document.getElementById('userRoleModal'),
      roleE: document.getElementById('roleE'),
      roleM: document.getElementById('roleM'),
      typingIndicator: document.getElementById('typingIndicator'),
      gameModal: document.getElementById('gameModal'),
      gameBoard: document.getElementById('gameBoard'),
      gameStatus: document.getElementById('gameStatus'),
      gameCloseBtn: document.getElementById('gameCloseBtn'),
      gameEndBtn: document.getElementById('gameEndBtn'),
      gamesPopover: document.getElementById('gamesPopover'),
      ticTacToeBtn: document.getElementById('ticTacToeBtn'),
      activeGamesList: document.getElementById('activeGamesList'),
      activeGamesTitle: document.getElementById('activeGamesTitle'),
      presenceE: document.getElementById('presenceE'),
      presenceM: document.getElementById('presenceM'),
      geoModal: document.getElementById('geoModal'),
      qaModal: document.getElementById('qaModal')
    };
  },

  setLive: function(status){
    var indicator = document.getElementById('liveStatus');
    if(!indicator) return;
    
    // Remove all status classes
    indicator.classList.remove('connected', 'error');
    
    // Map status strings to indicator states
    if(status === 'Connected' || status === 'Connected (Live)'){
      indicator.classList.add('connected');
      indicator.title = 'Connected';
    } else if(status === 'Connected (Polling)'){
      indicator.classList.add('connected');
      indicator.title = 'Connected (Polling)';
    } else if(status.toLowerCase().includes('error') || status.toLowerCase().includes('fail')){
      indicator.classList.add('error');
      indicator.title = 'Connection Error';
    } else {
      // Connecting or other states - show gray dot
      indicator.title = 'Connecting...';
    }
  },

  showThumbModal: function(){
    if(!this.els.thumbModalOverlay) return;
    this.els.thumbModalOverlay.classList.add('show');
    if(this.els.thumbOverlay) this.els.thumbOverlay.classList.add('show');
    document.body.classList.add('no-scroll');
  },

  hideThumbModal: function(){
    if(!this.els.thumbModalOverlay) return;
    this.els.thumbModalOverlay.classList.remove('show');
    if(this.els.thumbOverlay) this.els.thumbOverlay.classList.remove('show');
    document.body.classList.remove('no-scroll');
  },

  openLightbox: function(src){
    if(!src||!this.els.lightbox||!this.els.lightboxImg) return;
    if(this.els.lbLoading) this.els.lbLoading.style.display='flex';
    this.els.lightboxImg.style.display='none';
    this.els.lightboxImg.src='';
    this.els.lightbox.classList.add('show');

    var img = new Image();
    img.onload = function(){
      this.els.lightboxImg.src = src;
      this.els.lightboxImg.style.display='';
      if(this.els.lbLoading) this.els.lbLoading.style.display='none';
    }.bind(this);
    img.onerror = function(){
      if(this.els.lbLoading) this.els.lbLoading.style.display='none';
      alert('Failed to load image');
      this.hideLightbox();
    }.bind(this);
    img.src = src;
  },

  hideLightbox: function(){
    if(!this.els.lightbox||!this.els.lightboxImg) return;
    this.els.lightbox.classList.remove('show');
    this.els.lightboxImg.src='';
    this.els.lightboxImg.style.display='none';
    if(this.els.lbLoading){ 
      this.els.lbLoading.style.display='flex'; 
      this.els.lbLoading.innerHTML='<div class="spinner" role="status" aria-label="Loading"></div>'; 
    }
  },

  showUserRoleModal: function(){
    if(!this.els.userRoleModal) return;
    this.els.userRoleModal.classList.add('show');
    document.body.classList.add('no-scroll');
  },

  hideUserRoleModal: function(){
    if(!this.els.userRoleModal) return;
    this.els.userRoleModal.classList.remove('show');
    document.body.classList.remove('no-scroll');
  },

  showGamesMenu: function(){
    if(!this.els.gamesPopover) return;
    this.els.gamesPopover.classList.add('show');
    document.body.classList.add('no-scroll');
  },

  hideGamesMenu: function(){
    if(!this.els.gamesPopover) return;
    this.els.gamesPopover.classList.remove('show');
    document.body.classList.remove('no-scroll');
  },

  showGameModal: function(){
    if(!this.els.gameModal) return;
    this.els.gameModal.classList.add('show');
  },

  hideGameModal: function(){
    if(!this.els.gameModal) return;
    this.els.gameModal.classList.remove('show');
  },

  showGeoModal: function(){
    if(!this.els.geoModal) return;
    this.els.geoModal.classList.add('show');
    document.body.classList.add('no-scroll');
  },

  hideGeoModal: function(){
    if(!this.els.geoModal) return;
    this.els.geoModal.classList.remove('show');
    document.body.classList.remove('no-scroll');
  },

  showQAModal: function(){
    if(!this.els.qaModal) return;
    this.els.qaModal.classList.add('show');
    document.body.classList.add('no-scroll');
  },

  hideQAModal: function(){
    if(!this.els.qaModal) return;
    this.els.qaModal.classList.remove('show');
    document.body.classList.remove('no-scroll');
  },

  insertAtCursor: function(el, text){
    if(!el) return;
    el.focus && el.focus();
    var s = el.selectionStart ?? (el.value ? el.value.length : 0);
    var e = el.selectionEnd ?? s;
    var before = el.value.slice(0,s), after = el.value.slice(e);
    el.value = before + text + after;
    var pos = s + text.length;
    try{ el.setSelectionRange(pos,pos); }catch(e){}
    el.dispatchEvent(new Event('input',{bubbles:true}));
  },

  updatePresence: function(role, isActive){
    var badge = role === 'E' ? this.els.presenceE : this.els.presenceM;
    if(!badge) return;
    
    if(isActive){
      badge.classList.add('active');
    } else {
      badge.classList.remove('active');
    }
  }
};
