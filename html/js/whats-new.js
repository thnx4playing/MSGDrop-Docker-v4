// Path: html/js/whats-new.js
// ============================================================================
// WHATS-NEW.JS - Stepped "What's New" modal shown once per version
// ============================================================================

var WhatsNew = {
  VERSION: '2026-03-05',
  STORAGE_KEY: 'msgdrop_whats_new_seen',
  currentStep: 0,

  steps: [
    {
      title: 'Update title here',
      body: 'Update description here.'
    },
    {
      title: 'Update title here',
      body: 'Update description here.'
    },
    {
      title: 'Update title here',
      body: 'Update description here.'
    }
  ],

  init: function() {
    try {
      var seen = localStorage.getItem(this.STORAGE_KEY);
      if (seen === this.VERSION) return;
    } catch (e) {}
    this.show();
  },

  show: function() {
    this.currentStep = 0;

    var overlay = document.createElement('div');
    overlay.id = 'whatsNewModal';
    overlay.className = 'wn-modal show';

    var panel = document.createElement('div');
    panel.className = 'wn-panel';

    // Header
    var header = document.createElement('div');
    header.className = 'wn-header';
    header.innerHTML = '<div class="wn-title">msgdrop v4 updates</div>';
    panel.appendChild(header);

    // Body
    var body = document.createElement('div');
    body.className = 'wn-body';
    body.id = 'wnBody';
    panel.appendChild(body);

    // Dots
    var dots = document.createElement('div');
    dots.className = 'wn-dots';
    dots.id = 'wnDots';
    for (var i = 0; i < this.steps.length; i++) {
      var dot = document.createElement('div');
      dot.className = 'wn-dot' + (i === 0 ? ' active' : '');
      dots.appendChild(dot);
    }
    panel.appendChild(dots);

    // Button
    var actions = document.createElement('div');
    actions.className = 'wn-actions';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wn-btn';
    btn.id = 'wnBtn';
    btn.addEventListener('click', function() { WhatsNew.next(); });
    actions.appendChild(btn);
    panel.appendChild(actions);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    document.body.classList.add('no-scroll');

    this.renderStep(0);
  },

  renderStep: function(idx) {
    var step = this.steps[idx];
    var body = document.getElementById('wnBody');
    var btn = document.getElementById('wnBtn');
    var dots = document.getElementById('wnDots');
    if (!body || !btn || !dots) return;

    body.innerHTML =
      '<div class="wn-step-title">' + step.title + '</div>' +
      '<div class="wn-step-text">' + step.body + '</div>';

    btn.textContent = (idx < this.steps.length - 1) ? 'Next' : 'Close';

    var dotEls = dots.children;
    for (var i = 0; i < dotEls.length; i++) {
      if (i === idx) {
        dotEls[i].classList.add('active');
      } else {
        dotEls[i].classList.remove('active');
      }
    }
  },

  next: function() {
    this.currentStep++;
    if (this.currentStep >= this.steps.length) {
      this.close();
      return;
    }
    this.renderStep(this.currentStep);
  },

  close: function() {
    try {
      localStorage.setItem(this.STORAGE_KEY, this.VERSION);
    } catch (e) {}
    var modal = document.getElementById('whatsNewModal');
    if (modal) {
      modal.classList.remove('show');
      modal.remove();
    }
    document.body.classList.remove('no-scroll');
  }
};
