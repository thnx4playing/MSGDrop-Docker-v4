// ============================================================================
// RICH-LINKS.JS - YouTube, TikTok, Instagram Link Detection & Embedding
// ============================================================================
// Detects video links in messages and renders them as rich previews
// Tapping opens an in-app modal with the embedded video
// ============================================================================

var RichLinks = {
  // Platform configurations
  platforms: {
    youtube: {
      name: 'YouTube',
      icon: '▶️',
      color: '#FF0000',
      patterns: [
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/i,
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/i,
        /(?:https?:\/\/)?youtu\.be\/([a-zA-Z0-9_-]{11})/i,
        /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/i
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
        /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@[^\/]+\/video\/(\d+)/i,
        /(?:https?:\/\/)?(?:vm\.)?tiktok\.com\/([a-zA-Z0-9]+)/i,
        /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/t\/([a-zA-Z0-9]+)/i
      ],
      getThumbnail: function(videoId) {
        // TikTok doesn't provide free thumbnails, return null for placeholder
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
        /(?:https?:\/\/)?(?:www\.)?instagram\.com\/p\/([a-zA-Z0-9_-]+)/i,
        /(?:https?:\/\/)?(?:www\.)?instagram\.com\/reel\/([a-zA-Z0-9_-]+)/i,
        /(?:https?:\/\/)?(?:www\.)?instagram\.com\/reels\/([a-zA-Z0-9_-]+)/i
      ],
      getThumbnail: function(videoId) {
        // Instagram doesn't provide free thumbnails, return null for placeholder
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
    // Check if modal already exists
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
          '<iframe id="richLinkFrame" class="rich-link-frame" allowfullscreen allow="autoplay; encrypted-media"></iframe>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);
  },

  // Setup event listeners
  setupEventListeners: function() {
    var self = this;

    // Close button
    document.addEventListener('click', function(e) {
      if (e.target.id === 'richLinkCloseBtn') {
        self.hideModal();
      }
    });

    // Click outside to close
    document.addEventListener('click', function(e) {
      var modal = document.getElementById('richLinkModal');
      if (e.target === modal) {
        self.hideModal();
      }
    });

    // Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        self.hideModal();
      }
    });
  },

  // Detect if text contains a supported video link
  detectLink: function(text) {
    if (!text || typeof text !== 'string') return null;

    for (var platformKey in this.platforms) {
      var platform = this.platforms[platformKey];
      for (var i = 0; i < platform.patterns.length; i++) {
        var match = text.match(platform.patterns[i]);
        if (match && match[1]) {
          return {
            platform: platformKey,
            videoId: match[1],
            originalUrl: match[0],
            fullMatch: match
          };
        }
      }
    }
    return null;
  },

  // Extract all links from text
  detectAllLinks: function(text) {
    if (!text || typeof text !== 'string') return [];

    var links = [];
    var found = {};

    for (var platformKey in this.platforms) {
      var platform = this.platforms[platformKey];
      for (var i = 0; i < platform.patterns.length; i++) {
        var regex = new RegExp(platform.patterns[i].source, 'gi');
        var match;
        while ((match = regex.exec(text)) !== null) {
          var videoId = match[1];
          var key = platformKey + ':' + videoId;
          if (!found[key]) {
            found[key] = true;
            links.push({
              platform: platformKey,
              videoId: videoId,
              originalUrl: match[0]
            });
          }
        }
      }
    }
    return links;
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

    var thumbnailUrl = platform.getThumbnail(linkData.videoId);

    var inner = document.createElement('div');
    inner.className = 'rich-link-inner';

    // Thumbnail or placeholder
    var thumb = document.createElement('div');
    thumb.className = 'rich-link-thumb';
    
    if (thumbnailUrl) {
      thumb.style.backgroundImage = 'url(' + thumbnailUrl + ')';
    } else {
      thumb.classList.add('rich-link-placeholder');
      thumb.setAttribute('data-platform', linkData.platform);
    }

    // Play overlay
    var playOverlay = document.createElement('div');
    playOverlay.className = 'rich-link-play';
    playOverlay.innerHTML = '<svg viewBox="0 0 24 24" width="48" height="48"><path fill="white" d="M8 5v14l11-7z"/></svg>';

    // Platform badge
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
      self.showModal(linkData.platform, linkData.videoId);
    });

    return preview;
  },

  // Show the embed modal
  showModal: function(platformKey, videoId) {
    var platform = this.platforms[platformKey];
    if (!platform) return;

    var modal = document.getElementById('richLinkModal');
    var frame = document.getElementById('richLinkFrame');
    var loading = document.getElementById('richLinkLoading');
    var platformLabel = document.getElementById('richLinkPlatform');

    if (!modal || !frame) return;

    // Set platform label
    if (platformLabel) {
      platformLabel.innerHTML = platform.icon + ' ' + platform.name;
      platformLabel.style.color = platform.color;
    }

    // Show loading
    if (loading) loading.style.display = 'flex';
    frame.style.display = 'none';

    // Set iframe src
    var embedUrl = platform.getEmbed(videoId);
    frame.src = embedUrl;

    // Handle iframe load
    frame.onload = function() {
      if (loading) loading.style.display = 'none';
      frame.style.display = 'block';
    };

    // Show modal
    modal.classList.add('show');
    document.body.classList.add('no-scroll');

    this.currentEmbed = { platform: platformKey, videoId: videoId };
  },

  // Hide the embed modal
  hideModal: function() {
    var modal = document.getElementById('richLinkModal');
    var frame = document.getElementById('richLinkFrame');

    if (modal) {
      modal.classList.remove('show');
    }

    // Clear iframe to stop video
    if (frame) {
      frame.src = '';
    }

    document.body.classList.remove('no-scroll');
    this.currentEmbed = null;
  },

  // Render rich links in a message element
  renderInMessage: function(messageEl, text) {
    var links = this.detectAllLinks(text);
    if (links.length === 0) return;

    // Create container for previews
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
    // Check if the trimmed text is essentially just the URL
    return trimmed.replace(link.originalUrl, '').trim().length < 5;
  }
};

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() { RichLinks.init(); });
} else {
  RichLinks.init();
}
