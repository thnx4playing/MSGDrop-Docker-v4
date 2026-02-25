// Cookie expiration checker
var CookieChecker = {
  checkInterval: null,
  checkIntervalMs: 30000, // Check every 30 seconds
  lastCheckTime: 0,
  
  init: function(){
    var self = this;
    
    // Start checking periodically
    this.startChecking();
    
    // Also check when page becomes visible again (user switches back to app)
    document.addEventListener('visibilitychange', function(){
      if(!document.hidden){
        var now = Date.now();
        
        // If page was hidden for more than 5 minutes, force a hard check
        if(self.lastCheckTime && (now - self.lastCheckTime) > 300000){
          // Check cookie
          var hasUICookie = document.cookie.split(';').some(function(item){
            return item.trim().indexOf('session-ok=') === 0;
          });
          
          if(!hasUICookie){
            console.warn('[CookieChecker] Session expired while hidden, reloading...');
            // Force a hard reload to clear any cached state
            window.location.reload(true);
            return;
          }
        }
        
        self.checkAuth();
        self.lastCheckTime = now;
      }
    });
  },
  
  startChecking: function(){
    if(this.checkInterval) clearInterval(this.checkInterval);
    
    this.checkInterval = setInterval(function(){
      this.checkAuth();
    }.bind(this), this.checkIntervalMs);
    
    // Do initial check
    this.checkAuth();
  },
  
  stopChecking: function(){
    if(this.checkInterval){
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  },
  
  checkAuth: function(){
    // Check if the UI cookie exists and has a valid-looking value (not just 'true')
    var cookieVal = null;
    document.cookie.split(';').some(function(item){
      var trimmed = item.trim();
      if(trimmed.indexOf('session-ok=') === 0){
        cookieVal = trimmed.substring('session-ok='.length);
        return true;
      }
      return false;
    });

    this.lastCheckTime = Date.now();

    if(!cookieVal || cookieVal.length < 10){
      console.warn('[CookieChecker] Session expired or invalid, redirecting to /unlock');
      this.redirectToUnlock();
      return false;
    }

    return true;
  },
  
  redirectToUnlock: function(){
    this.stopChecking();
    
    // Clear any local state
    try {
      sessionStorage.clear();
    } catch(e){}
    
    // Redirect to unlock page
    var currentDrop = '';
    try {
      currentDrop = new URL(window.location.href).searchParams.get('drop') || 'default';
    } catch(e){
      currentDrop = 'default';
    }
    
    window.location.href = '/unlock?drop=' + encodeURIComponent(currentDrop);
  }
};
