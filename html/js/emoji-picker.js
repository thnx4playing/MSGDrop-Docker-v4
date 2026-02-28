// ============================================================================
// EMOJI-PICKER.JS — Shared emoji picker for compose + reactions
// ============================================================================

var EmojiPicker = {
  mode: null,         // 'compose' or 'reaction'
  callback: null,     // function(emoji) on selection
  recentEmojis: [],
  _overlay: null,
  _container: null,
  _searchInput: null,
  _tabRow: null,
  _grid: null,
  _debounceTimer: null,
  _observer: null,
  // Apple emoji CDN base (64px PNGs from emoji-datasource-apple)
  _cdnBase: 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.1.2/img/apple/64/',

  // Convert emoji character(s) to the hex codepoint filename used by the CDN
  _emojiToCodepoints: function(char){
    var codepoints = [];
    for(var i = 0; i < char.length; i++){
      var cp = char.codePointAt(i);
      codepoints.push(cp.toString(16));
      // Skip low surrogate of astral codepoints
      if(cp > 0xFFFF) i++;
    }
    return codepoints;
  },

  _emojiToUrl: function(char){
    return this._cdnBase + this._emojiToCodepoints(char).join('-') + '.png';
  },

  // Create an <img> element for an Apple-style emoji
  _createEmojiImg: function(char, size){
    var img = document.createElement('img');
    img.src = this._emojiToUrl(char);
    img.alt = char;
    img.loading = 'lazy';
    img.draggable = false;
    img.className = 'emoji-picker-img';
    if(size){ img.style.width = size + 'px'; img.style.height = size + 'px'; }
    // Fallback: if CDN 404s with fe0f, try without it
    var self = this;
    img.onerror = function(){
      if(this._triedFallback) return;
      this._triedFallback = true;
      var cps = self._emojiToCodepoints(char).filter(function(c){ return c !== 'fe0f'; });
      img.src = self._cdnBase + cps.join('-') + '.png';
    };
    return img;
  },

  init: function(){
    this.loadRecent();
    this.createModal();
  },

  createModal: function(){
    // Overlay
    var overlay = document.createElement('div');
    overlay.className = 'emoji-picker-overlay';
    overlay.addEventListener('click', function(e){
      if(e.target === overlay) this.close();
    }.bind(this));
    this._overlay = overlay;

    // Container
    var container = document.createElement('div');
    container.className = 'emoji-picker-container';
    container.addEventListener('click', function(e){ e.stopPropagation(); });

    // Header with search
    var header = document.createElement('div');
    header.className = 'emoji-picker-header';

    var searchWrap = document.createElement('div');
    searchWrap.className = 'emoji-picker-search-wrap';

    var searchIcon = document.createElement('span');
    searchIcon.className = 'emoji-picker-search-icon';
    searchIcon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>';

    var searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'emoji-picker-search';
    searchInput.placeholder = 'Search emoji';
    searchInput.autocomplete = 'off';
    searchInput.autocapitalize = 'off';
    searchInput.spellcheck = false;
    this._searchInput = searchInput;

    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'emoji-picker-clear-btn';
    clearBtn.textContent = '\u00D7';
    clearBtn.style.display = 'none';
    clearBtn.addEventListener('click', function(){
      searchInput.value = '';
      clearBtn.style.display = 'none';
      this.renderAllCategories();
      searchInput.focus();
    }.bind(this));

    searchInput.addEventListener('input', function(){
      clearBtn.style.display = searchInput.value ? 'flex' : 'none';
      if(this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(function(){
        var q = searchInput.value.trim().toLowerCase();
        if(q.length === 0){
          this.renderAllCategories();
        } else {
          this.search(q);
        }
      }.bind(this), 150);
    }.bind(this));

    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(searchInput);
    searchWrap.appendChild(clearBtn);
    header.appendChild(searchWrap);

    // Close button
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'emoji-picker-close-btn';
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener('click', function(){ this.close(); }.bind(this));
    header.appendChild(closeBtn);

    // Category tabs
    var tabRow = document.createElement('div');
    tabRow.className = 'emoji-picker-tabs';
    this._tabRow = tabRow;

    var cats = (typeof EMOJI_DATA !== 'undefined') ? EMOJI_DATA.categories : [];
    cats.forEach(function(cat){
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'emoji-picker-tab';
      tab.setAttribute('data-cat', cat.id);
      tab.appendChild(this._createEmojiImg(cat.icon, 20));
      tab.title = cat.name;
      tab.addEventListener('click', function(){
        this.scrollToCategory(cat.id);
      }.bind(this));
      tabRow.appendChild(tab);
    }.bind(this));

    // Grid scroll area
    var grid = document.createElement('div');
    grid.className = 'emoji-picker-grid';
    this._grid = grid;

    container.appendChild(header);
    container.appendChild(tabRow);
    container.appendChild(grid);
    overlay.appendChild(container);
    this._container = container;

    document.body.appendChild(overlay);
  },

  open: function(mode, callback){
    this.mode = mode;
    this.callback = callback;
    this.loadRecent();
    this.renderAllCategories();
    this._overlay.classList.add('open');
    // Reset search
    if(this._searchInput){
      this._searchInput.value = '';
      var clearBtn = this._container.querySelector('.emoji-picker-clear-btn');
      if(clearBtn) clearBtn.style.display = 'none';
    }
    // Scroll grid to top
    if(this._grid) this._grid.scrollTop = 0;
    // Focus search after animation
    setTimeout(function(){
      if(this._searchInput) this._searchInput.focus();
    }.bind(this), 100);
    // Set up intersection observer for tab highlighting
    this._setupObserver();
    // Highlight initial tab
    this._highlightTab(this.recentEmojis.length > 0 ? 'recent' : 'smileys');
  },

  close: function(){
    this._overlay.classList.remove('open');
    this.mode = null;
    this.callback = null;
    if(this._observer){
      this._observer.disconnect();
      this._observer = null;
    }
  },

  renderAllCategories: function(){
    if(!this._grid) return;
    this._grid.innerHTML = '';
    var frag = document.createDocumentFragment();

    var cats = (typeof EMOJI_DATA !== 'undefined') ? EMOJI_DATA.categories : [];
    var emojis = (typeof EMOJI_DATA !== 'undefined') ? EMOJI_DATA.emojis : [];

    // Recent
    if(this.recentEmojis.length > 0){
      var recentCat = cats.find(function(c){ return c.id === 'recent'; });
      var sectionEl = this._createSection('recent', recentCat ? recentCat.name : 'Recently Used', this.recentEmojis.map(function(ch){
        return { char: ch };
      }));
      frag.appendChild(sectionEl);
    }

    // All other categories
    cats.forEach(function(cat){
      if(cat.id === 'recent') return;
      var catEmojis = emojis.filter(function(e){ return e.cat === cat.id; });
      if(catEmojis.length === 0) return;
      var sectionEl = this._createSection(cat.id, cat.name, catEmojis);
      frag.appendChild(sectionEl);
    }.bind(this));

    this._grid.appendChild(frag);

    // Re-setup observer after DOM change
    if(this._overlay.classList.contains('open')){
      this._setupObserver();
    }
  },

  _createSection: function(catId, label, emojis){
    var section = document.createElement('div');
    section.className = 'emoji-picker-section';
    section.setAttribute('data-section', catId);

    var heading = document.createElement('div');
    heading.className = 'emoji-picker-section-label';
    heading.textContent = label;
    section.appendChild(heading);

    var grid = document.createElement('div');
    grid.className = 'emoji-picker-emoji-grid';

    emojis.forEach(function(emoji){
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-picker-emoji';
      btn.appendChild(this._createEmojiImg(emoji.char));
      btn.setAttribute('aria-label', emoji.name || emoji.char);
      btn.addEventListener('click', function(){
        this._selectEmoji(emoji.char);
      }.bind(this));
      grid.appendChild(btn);
    }.bind(this));

    section.appendChild(grid);
    return section;
  },

  renderGrid: function(emojis){
    if(!this._grid) return;
    this._grid.innerHTML = '';

    if(emojis.length === 0){
      var empty = document.createElement('div');
      empty.className = 'emoji-picker-empty';
      empty.textContent = 'No emoji found';
      this._grid.appendChild(empty);
      return;
    }

    var grid = document.createElement('div');
    grid.className = 'emoji-picker-emoji-grid';
    emojis.forEach(function(emoji){
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-picker-emoji';
      btn.appendChild(this._createEmojiImg(emoji.char));
      btn.setAttribute('aria-label', emoji.name || emoji.char);
      btn.addEventListener('click', function(){
        this._selectEmoji(emoji.char);
      }.bind(this));
      grid.appendChild(btn);
    }.bind(this));

    this._grid.appendChild(grid);
  },

  search: function(query){
    if(!query || typeof EMOJI_DATA === 'undefined') return;
    var terms = query.split(/\s+/);
    var results = EMOJI_DATA.emojis.filter(function(e){
      return terms.every(function(term){
        if(e.name.indexOf(term) !== -1) return true;
        if(e.keywords && e.keywords.some(function(kw){ return kw.indexOf(term) !== -1; })) return true;
        return false;
      });
    });
    this.renderGrid(results);
  },

  scrollToCategory: function(catId){
    if(!this._grid) return;
    var section = this._grid.querySelector('[data-section="' + catId + '"]');
    if(section){
      // Scroll the section into view within the grid
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    this._highlightTab(catId);
  },

  _highlightTab: function(catId){
    if(!this._tabRow) return;
    var tabs = this._tabRow.querySelectorAll('.emoji-picker-tab');
    tabs.forEach(function(tab){
      tab.classList.toggle('active', tab.getAttribute('data-cat') === catId);
    });
  },

  _setupObserver: function(){
    if(this._observer){
      this._observer.disconnect();
    }
    if(!this._grid) return;

    var self = this;
    this._observer = new IntersectionObserver(function(entries){
      // Find the first visible section
      var visible = null;
      entries.forEach(function(entry){
        if(entry.isIntersecting){
          if(!visible || entry.boundingClientRect.top < visible.boundingClientRect.top){
            visible = entry;
          }
        }
      });
      if(visible){
        var catId = visible.target.getAttribute('data-section');
        if(catId) self._highlightTab(catId);
      }
    }, {
      root: this._grid,
      threshold: 0,
      rootMargin: '0px 0px -80% 0px'
    });

    var sections = this._grid.querySelectorAll('.emoji-picker-section');
    sections.forEach(function(s){ self._observer.observe(s); });
  },

  _selectEmoji: function(char){
    if(this.callback){
      this.callback(char);
    }
    this.addRecent(char);
    this.close();
  },

  addRecent: function(char){
    // Remove if exists, add to front
    this.recentEmojis = this.recentEmojis.filter(function(e){ return e !== char; });
    this.recentEmojis.unshift(char);
    // Cap at 32
    if(this.recentEmojis.length > 32){
      this.recentEmojis = this.recentEmojis.slice(0, 32);
    }
    this.saveRecent();
  },

  loadRecent: function(){
    try {
      var raw = localStorage.getItem('msgdrop_recent_emojis');
      if(raw){
        var parsed = JSON.parse(raw);
        if(Array.isArray(parsed)){
          this.recentEmojis = parsed;
        }
      }
    } catch(e){}
  },

  saveRecent: function(){
    try {
      localStorage.setItem('msgdrop_recent_emojis', JSON.stringify(this.recentEmojis));
    } catch(e){}
  }
};
