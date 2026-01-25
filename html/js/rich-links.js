// ============================================================================
// RICH-LINKS.JS - YouTube, TikTok, Instagram Link Detection & Embedding
// ============================================================================
// Detects video links in messages and renders them as rich previews
// Tapping opens an in-app modal with the embedded video
// ============================================================================

var RichLinks = {
  // Cache for resolved TikTok URLs
  tiktokCache: {},

  // Platform configurations
  platforms: {
    youtube: {
      name: 'YouTube',
      icon: '▶️',
      color: '#FF0000',
      patterns: [
        { regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})(?:[&\?][^\s]*)?/i, type: 'watch' },
        { regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})(?:[&\?][^\s]*)?/i, type: 'shorts' },
        { regex: /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})(?:[&\?][^\s]*)?/i, type: 'short' },
        { regex: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})(?:[&\?][^\s]*)?/i, type: 'embed' }
      ],
      getThumbnail: function(videoId) {
        return 'https://img.youtube.com/vi/' + videoId + '/hqdefault.jpg';
      },
      getEmbed: function(videoId) {
        return 'https://www.youtube.com/embed/' + videoId + '?autoplay=1&rel=0';
      }
    },
    tiktok: {
      name: 'TikTok',
      icon: '🎵',
      color: '#000000',
      patterns: [
        // Full URL with numeric video ID (these work directly with embed)
        { regex: /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([^\/]+)\/video\/(\d+)(?:[&\?][^\s]*)?/i, type: 'full', hasUsername: true },
        // Short URLs (need resolution)
        { regex: /(?:https?:\/\/)?vm\.tiktok\.com\/([a-zA-Z0-9]+)\/?(?:[&\?][^\s]*)?/i, type: 'vm' },
        { regex: /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/t\/([a-zA-Z0-9]+)\/?(?:[&\?][^\s]*)?/i, type: 'short' }
      ],
      getThumbnail: function(videoId) {
        return null;
      },
      getEmbed: function(videoId) {
        return 'https://www.tiktok.com/embed/v2/' + videoId;
      }
    },
    instagram: {
      name: 'Instagram',
      icon: '📸',
      color: '#E4405F',
      patterns: [
        { regex: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/p\/([a-zA-Z0-9_-]+)\/?(?:[&\?][^\s]*)?/i, type: 'post' },
        { regex: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/reel\/([a-zA-Z0-9_-]+)\/?(?:[&\?][^\s]*)?/i, type: 'reel' },
        { regex: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/reels\/([a-zA-Z0-9_-]+)\/?(?:[&\?][^\s]*)?/i, type: 'reels' }
      ],
      getThumbnail: function(videoId) {
        return null;
      },
      getEmbed: function(videoId) {
        return 'https://www.instagram.com/p/' + videoId + '/embed';
      }
    }
  },

  // Current modal state
  currentEmbed: null,

  // Initialize the module
  init: function() {
    this.createModal();
    this.setupEventListeners();
    console.log('✓ RichLinks initialized');
  },

  // Create the embed modal
  createModal: function() {
    if (document.getElementById('richLinkModal')) return;

    var modal = document.createElement('div');
    modal.id = 'richLinkModal';
    modal.className = 'rich-link-modal';
    modal.innerHTML = 
      '<div class="rich-link-container">' +
        '<button id="richLinkCloseBtn" class="modal-close-badge" type="button" aria-label="Close">&times;</button>' +
        '<div class="rich-link-header">' +
          '<span id="richLinkPlatform" class="rich-link-platform"></span>' +
        '</div>' +
        '<div class="rich-link-body">' +
          '<div id="richLinkLoading" class="rich-link-loading">' +
            '<div class="spinner"></div>' +
          '</div>' +
          '<div id="richLinkError" class="rich-link-error" style="display:none;">' +
            '<div class="rich-link-error-icon">⚠️</div>' +
            '<div class="rich-link-error-text">Unable to load video</div>' +
            '<a id="richLinkOpenExternal" class="rich-link-external-btn" href="#" target="_blank" rel="noopener">Open in App</a>' +
          '</div>' +
          '<iframe id="richLinkFrame" class="rich-link-frame" allowfullscreen allow="autoplay; encrypted-media"></iframe>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);
  },

  // Setup event listeners
  setupEventListeners: function() {
    var self = this;

    document.addEventListener('click', function(e) {
      if (e.target.id === 'richLinkCloseBtn') {
        self.hideModal();
      }
    });

    document.addEventListener('click', function(e) {
      var modal = document.getElementById('richLinkModal');
      if (e.target === modal) {
        self.hideModal();
      }
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        self.hideModal();
      }
    });
  },

  // Detect if text contains a supported video link (returns first match only)
  detectLink: function(text) {
    if (!text || typeof text !== 'string') return null;

    for (var platformKey in this.platforms) {
      var platform = this.platforms[platformKey];
      for (var i = 0; i < platform.patterns.length; i++) {
        var patternObj = platform.patterns[i];
        var match = text.match(patternObj.regex);
        if (match) {
          var videoId;
          var originalUrl = match[0];
          var needsResolution = false;
          var username = null;

          if (platformKey === 'tiktok') {
            if (patternObj.hasUsername) {
              // Full URL: match[1] is username, match[2] is video ID
              username = match[1];
              videoId = match[2];
            } else {
              // Short URL: needs resolution
              videoId = match[1];
              needsResolution = true;
            }
          } else {
            videoId = match[1];
          }

          return {
            platform: platformKey,
            videoId: videoId,
            originalUrl: originalUrl,
            needsResolution: needsResolution,
            username: username,
            patternType: patternObj.type
          };
        }
      }
    }
    return null;
  },

  // Extract all UNIQUE links from text (no duplicates)
  detectAllLinks: function(text) {
    if (!text || typeof text !== 'string') return [];

    var links = [];
    var foundUrls = new Set();

    // Process each platform
    for (var platformKey in this.platforms) {
      var platform = this.platforms[platformKey];
      
      // Try each pattern for this platform
      for (var i = 0; i < platform.patterns.length; i++) {
        var patternObj = platform.patterns[i];
        var regex = new RegExp(patternObj.regex.source, 'gi');
        var match;
        
        while ((match = regex.exec(text)) !== null) {
          var originalUrl = match[0];
          
          // Skip if we've already processed this exact URL string
          if (foundUrls.has(originalUrl)) continue;
          foundUrls.add(originalUrl);

          var videoId;
          var needsResolution = false;
          var username = null;

          if (platformKey === 'tiktok') {
            if (patternObj.hasUsername) {
              username = match[1];
              videoId = match[2];
            } else {
              videoId = match[1];
              needsResolution = true;
            }
          } else {
            videoId = match[1];
          }

          links.push({
            platform: platformKey,
            videoId: videoId,
            originalUrl: originalUrl,
            needsResolution: needsResolution,
            username: username,
            patternType: patternObj.type
          });
        }
      }
    }
    
    return links;
  },

  // Resolve TikTok short URL to full video ID via backend
  resolveTikTokUrl: async function(shortCode, originalUrl) {
    // Check cache first
    if (this.tiktokCache[shortCode]) {
      return this.tiktokCache[shortCode];
    }

    try {
      var response = await fetch('/api/resolve-tiktok?url=' + encodeURIComponent(originalUrl), {
        credentials: 'include'
      });
      
      if (!response.ok) {
        console.warn('TikTok resolution failed:', response.status);
        return null;
      }

      var data = await response.json();
      if (data.videoId) {
        this.tiktokCache[shortCode] = data.videoId;
        return data.videoId;
      }
    } catch (e) {
      console.error('TikTok resolution error:', e);
    }
    
    return null;
  },

  // Create a preview element for a link
  createPreview: function(linkData) {
    var self = this;
    var platform = this.platforms[linkData.platform];
    if (!platform) return null;

    var preview = document.createElement('div');
    preview.className = 'rich-link-preview rich-link-' + linkData.platform;
    preview.setAttribute('data-platform', linkData.platform);
    preview.setAttribute('data-video-id', linkData.videoId);
    preview.setAttribute('data-original-url', linkData.originalUrl);
    if (linkData.needsResolution) {
      preview.setAttribute('data-needs-resolution', 'true');
    }

    var thumbnailUrl = platform.getThumbnail(linkData.videoId);

    var inner = document.createElement('div');
    inner.className = 'rich-link-inner';

    var thumb = document.createElement('div');
    thumb.className = 'rich-link-thumb';
    
    if (thumbnailUrl) {
      thumb.style.backgroundImage = 'url(' + thumbnailUrl + ')';
    } else {
      thumb.classList.add('rich-link-placeholder');
      thumb.setAttribute('data-platform', linkData.platform);
    }

    var playOverlay = document.createElement('div');
    playOverlay.className = 'rich-link-play';
    playOverlay.innerHTML = '<svg viewBox="0 0 24 24" width="48" height="48"><path fill="white" d="M8 5v14l11-7z"/></svg>';

    var badge = document.createElement('div');
    badge.className = 'rich-link-badge';
    badge.style.backgroundColor = platform.color;
    badge.innerHTML = '<span class="rich-link-icon">' + platform.icon + '</span><span class="rich-link-name">' + platform.name + '</span>';

    thumb.appendChild(playOverlay);
    inner.appendChild(thumb);
    inner.appendChild(badge);
    preview.appendChild(inner);

    // Click handler
    preview.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      self.showModal(linkData.platform, linkData.videoId, linkData.needsResolution, linkData.originalUrl);
    });

    return preview;
  },

  // Show the embed modal
  showModal: async function(platformKey, videoId, needsResolution, originalUrl) {
    var self = this;
    var platform = this.platforms[platformKey];
    if (!platform) return;

    var modal = document.getElementById('richLinkModal');
    var frame = document.getElementById('richLinkFrame');
    var loading = document.getElementById('richLinkLoading');
    var errorDiv = document.getElementById('richLinkError');
    var externalLink = document.getElementById('richLinkOpenExternal');
    var platformLabel = document.getElementById('richLinkPlatform');

    if (!modal || !frame) return;

    // Set platform label
    if (platformLabel) {
      platformLabel.innerHTML = platform.icon + ' ' + platform.name;
      platformLabel.style.color = platform.color;
    }

    // Reset state
    if (loading) loading.style.display = 'flex';
    if (errorDiv) errorDiv.style.display = 'none';
    frame.style.display = 'none';
    frame.src = '';

    // Set external link
    if (externalLink && originalUrl) {
      externalLink.href = originalUrl;
      externalLink.textContent = 'Open in ' + platform.name;
      externalLink.style.display = 'none';
    }

    // Show modal
    modal.classList.add('show');
    modal.setAttribute('data-platform', platformKey);
    document.body.classList.add('no-scroll');

    // Resolve TikTok short URLs if needed
    var resolvedVideoId = videoId;
    if (platformKey === 'tiktok' && needsResolution) {
      resolvedVideoId = await this.resolveTikTokUrl(videoId, originalUrl);
      
      if (!resolvedVideoId) {
        // Resolution failed - show error with external link
        if (loading) loading.style.display = 'none';
        if (errorDiv) {
          errorDiv.style.display = 'flex';
          if (externalLink) externalLink.style.display = 'inline-block';
        }
        return;
      }
    }

    // Set iframe src
    var embedUrl = platform.getEmbed(resolvedVideoId);
    frame.src = embedUrl;

    // Handle iframe load
    frame.onload = function() {
      if (loading) loading.style.display = 'none';
      frame.style.display = 'block';
    };

    // Handle iframe error (timeout fallback)
    setTimeout(function() {
      if (loading && loading.style.display !== 'none') {
        // Still loading after 10s - might be an issue
        if (platformKey === 'tiktok') {
          loading.style.display = 'none';
          if (errorDiv) {
            errorDiv.style.display = 'flex';
            if (externalLink) externalLink.style.display = 'inline-block';
          }
        }
      }
    }, 10000);

    this.currentEmbed = { platform: platformKey, videoId: resolvedVideoId, originalUrl: originalUrl };
  },

  // Hide the embed modal
  hideModal: function() {
    var modal = document.getElementById('richLinkModal');
    var frame = document.getElementById('richLinkFrame');
    var errorDiv = document.getElementById('richLinkError');

    if (modal) {
      modal.classList.remove('show');
    }

    if (frame) {
      frame.src = '';
    }

    if (errorDiv) {
      errorDiv.style.display = 'none';
    }

    document.body.classList.remove('no-scroll');
    this.currentEmbed = null;
  },

  // Render rich links in a message element
  renderInMessage: function(messageEl, text) {
    var links = this.detectAllLinks(text);
    if (links.length === 0) return;

    var container = document.createElement('div');
    container.className = 'rich-links-container';

    for (var i = 0; i < links.length; i++) {
      var preview = this.createPreview(links[i]);
      if (preview) {
        container.appendChild(preview);
      }
    }

    if (container.children.length > 0) {
      messageEl.appendChild(container);
    }
  },

  // Check if a message contains only a link (for cleaner display)
  isOnlyLink: function(text) {
    if (!text || typeof text !== 'string') return false;
    var trimmed = text.trim();
    var link = this.detectLink(trimmed);
    if (!link) return false;
    return trimmed.replace(link.originalUrl, '').trim().length < 5;
  }
};

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() { RichLinks.init(); });
} else {
  RichLinks.init();
}
