// Path: html/js/geogame.js
// ============================================================================
// GEOGAME.JS - GeoGuessr clone for MSGDrop v4  (extends GameEngine)
// ============================================================================

window.GeoGame = new (class extends GameEngine {

  constructor(config) {
    super(config);

    // ── Geo-specific state (merged into base this.state) ──
    this.state.round            = 0;
    this.state.totalRounds      = 5;
    this.state.location         = null;
    this.state.myGuess           = null;
    this.state.otherPlayerGuessed = false;
    this.state.roundResult       = null;
    this.state.scores            = {E: 0, M: 0};
    this.state.roundHistory      = [];
    this.state.otherPlayerHasGameOpen = false;

    // ── Google Maps objects ──
    this.panorama        = null;
    this.guessMap        = null;
    this.guessMarker     = null;
    this.resultMap       = null;
    this.mapsLoaded      = false;
    this._resultOverlays = [];
  }

  // =========================================================================
  //  GOOGLE MAPS API LOADING
  // =========================================================================

  loadMapsAPI(callback) {
    if (window.google && window.google.maps) { callback(); return; }
    fetch('/api/geo/config', {credentials: 'include'})
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.mapsApiKey) { alert('Google Maps API key not configured'); return; }
        var script = document.createElement('script');
        script.src = 'https://maps.googleapis.com/maps/api/js?key=' + data.mapsApiKey + '&loading=async&callback=_geoMapsReady';
        script.async = true;
        window._geoMapsReady = function() {
          delete window._geoMapsReady;
          callback();
        };
        document.head.appendChild(script);
      })
      .catch(function(e) { console.error('[GeoGame] Failed to load Maps API config:', e); });
  }

  // =========================================================================
  //  OP ROUTING  (game-specific ops)
  // =========================================================================

  handleGameOp(op, data) {
    if (op === 'geo_started') {
      this.clearInviteCard();
      this.state.gameId = data.gameId;
      this.state.round = data.round;
      this.state.totalRounds = data.totalRounds;
      this.state.location = data.location;
      this.state.phase = 'guessing';
      this.state.myGuess = null;
      this.state.otherPlayerGuessed = false;
      this.state.scores = {E: 0, M: 0};
      this.state.roundHistory = [];
      var self = this;
      this.loadMapsAPI(function() {
        self.mapsLoaded = true;
        self.showModal();
        self.renderGuessing();
      });
    }
    else if (op === 'geo_guess_received') {
      if (data.player !== Messages.myRole) {
        this.state.otherPlayerGuessed = true;
        this.updateGuessStatus();
      }
    }
    else if (op === 'geo_round_result') {
      this.state.roundResult = data;
      this.state.phase = 'result';
      this.state.scores = data.totalScores;
      this.state.roundHistory.push(data);
      this.renderRoundResult();
    }
    else if (op === 'geo_next_round') {
      this.state.round = data.round;
      this.state.location = data.location;
      this.state.phase = 'guessing';
      this.state.myGuess = null;
      this.state.otherPlayerGuessed = false;
      this.state.roundResult = null;
      this.renderGuessing();
    }
    else if (op === 'geo_game_end') {
      this.state.phase = 'summary';
      this.state.scores = data.totalScores;
      this.renderGameSummary(data);
    }
    else if (op === 'geo_player_opened') {
      if (data.player !== Messages.myRole) this.state.otherPlayerHasGameOpen = true;
    }
    else if (op === 'geo_player_closed') {
      if (data.player !== Messages.myRole) this.state.otherPlayerHasGameOpen = false;
    }
  }

  // =========================================================================
  //  RESUME  (reconnecting player rebuilds UI from server snapshot)
  // =========================================================================

  handleResume(data) {
    this.state.gameId = data.gameId;
    this.state.round = data.round;
    this.state.totalRounds = data.totalRounds;
    this.state.location = data.location;
    this.state.scores = data.scores;
    this.state.otherPlayerGuessed = data.otherPlayerGuessed || false;
    this.state.roundHistory = data.roundHistory || [];
    this.state.myGuess = null;

    var self = this;

    if (data.phase === 'result' && data.roundResult) {
      this.state.phase = 'result';
      this.state.roundResult = {
        location: data.location,
        results: data.roundResult,
        totalScores: data.scores
      };
      this.loadMapsAPI(function() {
        self.mapsLoaded = true;
        self.showModal();
        self.renderRoundResult();
      });
    } else if (data.myGuessSubmitted) {
      this.state.phase = 'waiting';
      this.loadMapsAPI(function() {
        self.mapsLoaded = true;
        self.showModal();
        self.renderGuessing();
        // Re-show waiting state
        var btn = document.getElementById('geoSubmitBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Waiting...'; }
        self.stopTimer();
        self.updateGuessStatus();
      });
    } else {
      this.state.phase = 'guessing';
      this.loadMapsAPI(function() {
        self.mapsLoaded = true;
        self.showModal();
        self.renderGuessing();
      });
    }
  }

  // =========================================================================
  //  PLAYER RECONNECTED  (geo-specific phase restoration)
  // =========================================================================

  handlePlayerReconnected(data) {
    if (data.player === Messages.myRole) return;
    if (!this.state.gameId) return;

    // Let base class remove pause card & overlay
    super.handlePlayerReconnected(data);

    // Restore phase based on current state
    if (this.state.roundResult) {
      this.state.phase = 'result';
    } else if (this.state.myGuess) {
      this.state.phase = 'waiting';
    } else {
      this.state.phase = 'guessing';
      this._startGeoTimer();
    }
  }

  // =========================================================================
  //  FORFEIT  (override to show geo-specific UI)
  // =========================================================================

  renderForfeitMessage() {
    var guessArea = document.getElementById('geoGuessArea');
    var resultArea = document.getElementById('geoResultArea');
    var summaryArea = document.getElementById('geoSummaryArea');
    if (guessArea) guessArea.style.display = 'none';
    if (resultArea) resultArea.style.display = 'none';
    if (summaryArea) {
      summaryArea.style.display = 'block';
      summaryArea.innerHTML = '<div class="geo-summary-title">Other player left the game</div>';
    }
  }

  // =========================================================================
  //  RESET STATE
  // =========================================================================

  resetState() {
    super.resetState();
    this.state.round = 0;
    this.state.totalRounds = 5;
    this.state.location = null;
    this.state.myGuess = null;
    this.state.otherPlayerGuessed = false;
    this.state.roundResult = null;
    this.state.scores = {E: 0, M: 0};
    this.state.roundHistory = [];
    if (this.guessMarker) { this.guessMarker.setMap(null); this.guessMarker = null; }
    if (this._resultOverlays) {
      this._resultOverlays.forEach(function(o) { o.setMap(null); });
      this._resultOverlays = [];
    }
    // Force fresh panorama/maps on next game to avoid stale location display
    this.panorama = null;
    this.guessMap = null;
    this.resultMap = null;
  }

  // =========================================================================
  //  GEO TIMER  (uses base class startTimer with geo-specific callbacks)
  // =========================================================================

  /** Start the 60-second guess timer with geo-specific tick & expiry logic. */
  _startGeoTimer() {
    var self = this;
    this.startTimer(60,
      // onTick
      function(remaining) {
        var timerEl = document.getElementById('geoTimer');
        if (timerEl) {
          timerEl.textContent = self.getTimerDisplay(remaining);
          if (remaining <= 10) timerEl.classList.add('warning');
          else timerEl.classList.remove('warning');
        }
      },
      // onExpire
      function() {
        if (self.state.phase === 'guessing') {
          if (!self.state.myGuess) {
            // Auto-guess center of map
            var center = self.guessMap
              ? self.guessMap.getCenter()
              : {lat: function(){return 20;}, lng: function(){return 0;}};
            self.placeGuess(center.lat(), center.lng());
          }
          self.submitGuess();
        }
      }
    );
  }

  // =========================================================================
  //  RENDERING: GUESSING PHASE
  // =========================================================================

  renderGuessing() {
    var roundLabel = document.getElementById('geoRoundLabel');
    if (roundLabel) roundLabel.textContent = 'Round ' + this.state.round + ' of ' + this.state.totalRounds;

    this.updateScoreDisplay();

    // Toggle areas
    var guessArea = document.getElementById('geoGuessArea');
    var resultArea = document.getElementById('geoResultArea');
    var summaryArea = document.getElementById('geoSummaryArea');
    var scoreboardArea = document.getElementById('geoScoreboardArea');
    if (resultArea) resultArea.style.display = 'none';
    if (summaryArea) summaryArea.style.display = 'none';
    if (scoreboardArea) scoreboardArea.style.display = 'none';
    if (guessArea) {
      guessArea.style.display = 'flex';
      guessArea.classList.remove('show-map');
    }
    var toggleBtn = document.getElementById('geoViewToggle');
    if (toggleBtn) toggleBtn.textContent = 'Guess Location';

    var submitBtn = document.getElementById('geoSubmitBtn');
    var nextBtn = document.getElementById('geoNextBtn');
    if (submitBtn) { submitBtn.style.display = ''; submitBtn.disabled = true; submitBtn.textContent = 'Submit Guess'; }
    if (nextBtn) nextBtn.style.display = 'none';

    // Street View panorama
    var panoDiv = document.getElementById('geoPanorama');
    if (!this.panorama) {
      this.panorama = new google.maps.StreetViewPanorama(panoDiv, {
        position: {lat: this.state.location.lat, lng: this.state.location.lng},
        pov: {heading: 0, pitch: 0},
        zoom: 0,
        addressControl: false,
        showRoadLabels: false,
        linksControl: true,
        panControl: true,
        zoomControl: true,
        fullscreenControl: false,
        motionTracking: false,
        motionTrackingControl: false,
        source: google.maps.StreetViewSource.OUTDOOR
      });
    } else {
      // Use StreetViewService to find nearest outdoor panorama
      var sv = new google.maps.StreetViewService();
      var loc = this.state.location;
      var self = this;
      sv.getPanorama({
        location: {lat: loc.lat, lng: loc.lng},
        radius: 500,
        source: google.maps.StreetViewSource.OUTDOOR
      }, function(data, status) {
        if (status === 'OK' && data && data.location && data.location.latLng) {
          self.panorama.setPosition(data.location.latLng);
        } else {
          self.panorama.setPosition({lat: loc.lat, lng: loc.lng});
        }
        self.panorama.setPov({heading: 0, pitch: 0});
        self.panorama.setZoom(0);
      });
    }

    // Guess mini-map
    var mapDiv = document.getElementById('geoGuessMap');
    var self = this;
    if (!this.guessMap) {
      this.guessMap = new google.maps.Map(mapDiv, {
        center: {lat: 20, lng: 0},
        zoom: 1,
        mapTypeId: 'roadmap',
        disableDefaultUI: true,
        zoomControl: true,
        gestureHandling: 'greedy',
        clickableIcons: false
      });
      this.guessMap.addListener('click', function(e) {
        self.placeGuess(e.latLng.lat(), e.latLng.lng());
      });
    } else {
      this.guessMap.setCenter({lat: 20, lng: 0});
      this.guessMap.setZoom(1);
    }

    // Clear old guess marker
    if (this.guessMarker) { this.guessMarker.setMap(null); this.guessMarker = null; }
    this.state.myGuess = null;
    this.updateGuessStatus();
    this._startGeoTimer();
  }

  // =========================================================================
  //  GUESS PLACEMENT & SUBMISSION
  // =========================================================================

  placeGuess(lat, lng) {
    if (this.state.phase !== 'guessing') return;
    this.state.myGuess = {lat: lat, lng: lng};
    var self = this;
    if (this.guessMarker) {
      this.guessMarker.setPosition({lat: lat, lng: lng});
    } else {
      this.guessMarker = new google.maps.Marker({
        position: {lat: lat, lng: lng},
        map: this.guessMap,
        draggable: true,
        title: 'Your guess'
      });
      this.guessMarker.addListener('dragend', function(e) {
        self.state.myGuess = {lat: e.latLng.lat(), lng: e.latLng.lng()};
      });
    }
    var btn = document.getElementById('geoSubmitBtn');
    if (btn) btn.disabled = false;
  }

  submitGuess() {
    if (!this.state.myGuess || this.state.phase !== 'guessing') return;
    this.stopTimer();
    var btn = document.getElementById('geoSubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Waiting...'; }
    this.state.phase = 'waiting';
    this._sendOp('geo_guess', {
      gameId: this.state.gameId,
      lat: this.state.myGuess.lat,
      lng: this.state.myGuess.lng
    });
    this.updateGuessStatus();
  }

  updateGuessStatus() {
    var statusEl = document.getElementById('geoGuessStatus');
    if (!statusEl) return;
    var otherPlayer = Messages.myRole === 'E' ? 'M' : 'E';
    if (this.state.phase === 'waiting') {
      statusEl.textContent = this.state.otherPlayerGuessed
        ? 'Processing results...'
        : 'Waiting for ' + otherPlayer + ' to guess...';
    } else if (this.state.phase === 'guessing') {
      statusEl.textContent = this.state.otherPlayerGuessed
        ? otherPlayer + ' has guessed \u2014 your turn!'
        : 'Drop a pin on the map to guess';
    }
  }

  // =========================================================================
  //  RENDERING: ROUND RESULT
  // =========================================================================

  renderRoundResult() {
    this.stopTimer();
    var data = this.state.roundResult;
    var guessArea = document.getElementById('geoGuessArea');
    var resultArea = document.getElementById('geoResultArea');
    if (guessArea) guessArea.style.display = 'none';
    if (resultArea) resultArea.style.display = 'flex';

    var resultMapDiv = document.getElementById('geoResultMap');
    var loc = data.location;

    if (!this.resultMap) {
      this.resultMap = new google.maps.Map(resultMapDiv, {
        center: {lat: loc.lat, lng: loc.lng},
        zoom: 3,
        disableDefaultUI: true,
        zoomControl: true
      });
    } else {
      this.resultMap.setCenter({lat: loc.lat, lng: loc.lng});
    }

    // Clear old overlays
    if (this._resultOverlays) {
      this._resultOverlays.forEach(function(o) { o.setMap(null); });
    }
    this._resultOverlays = [];

    // Actual location marker (green)
    var actualMarker = new google.maps.Marker({
      position: {lat: loc.lat, lng: loc.lng},
      map: this.resultMap,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        fillColor: '#22c55e', fillOpacity: 1,
        strokeWeight: 3, strokeColor: '#fff', scale: 10
      },
      title: loc.name + ', ' + loc.country
    });
    this._resultOverlays.push(actualMarker);

    var bounds = new google.maps.LatLngBounds();
    bounds.extend({lat: loc.lat, lng: loc.lng});

    var colors = {E: '#ef4444', M: '#3b82f6'};
    var self = this;
    ['E', 'M'].forEach(function(p) {
      if (!data.results[p]) return;
      var r = data.results[p];
      var marker = new google.maps.Marker({
        position: {lat: r.guessLat, lng: r.guessLng},
        map: self.resultMap,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: colors[p], fillOpacity: 1,
          strokeWeight: 2, strokeColor: '#fff', scale: 8
        },
        label: {text: p, color: '#fff', fontSize: '11px', fontWeight: '700'},
        title: p + "'s guess"
      });
      var line = new google.maps.Polyline({
        path: [{lat: loc.lat, lng: loc.lng}, {lat: r.guessLat, lng: r.guessLng}],
        geodesic: true,
        strokeColor: colors[p], strokeOpacity: 0.7, strokeWeight: 2,
        map: self.resultMap
      });
      self._resultOverlays.push(marker, line);
      bounds.extend({lat: r.guessLat, lng: r.guessLng});
    });

    this.resultMap.fitBounds(bounds, 50);

    // Result text
    var resultText = document.getElementById('geoResultText');
    if (resultText) {
      var eScore = (data.results.E && data.results.E.score) || 0;
      var mScore = (data.results.M && data.results.M.score) || 0;
      var roundWinner = eScore > mScore ? 'E' : (mScore > eScore ? 'M' : null);
      var totalE = (this.state.scores && this.state.scores.E) || 0;
      var totalM = (this.state.scores && this.state.scores.M) || 0;

      var html = '<div class="geo-result-round-badge">Round ' + this.state.round + ' of ' + this.state.totalRounds + '</div>';
      html += '<div class="geo-result-location">\uD83D\uDCCD ' + loc.name + '</div>';
      ['E', 'M'].forEach(function(p) {
        if (!data.results[p]) return;
        var r = data.results[p];
        var distMi = r.distance * 0.621371;
        var distStr = distMi < 0.1 ? Math.round(distMi * 5280) + ' ft' :
                      distMi < 100 ? distMi.toFixed(1) + ' mi' :
                      Math.round(distMi) + ' mi';
        var isWinner = (roundWinner === p);
        html += '<div class="geo-result-player geo-result-' + p.toLowerCase() +
          (isWinner ? ' geo-result-winner' : '') + '">' +
          '<span class="geo-player-label">' + p + '</span>' +
          '<span class="geo-player-dist">' + distStr + '</span>' +
          '<span class="geo-player-score">+' + r.score + '</span>' +
          (isWinner ? '<span class="geo-round-winner-badge">&#9733;</span>' : '') +
          '</div>';
      });
      html += '<div class="geo-result-total">' +
        '<span class="geo-result-total-label">Total</span>' +
        '<span class="geo-result-total-e">E: ' + totalE + '</span>' +
        '<span class="geo-result-total-sep">\u2014</span>' +
        '<span class="geo-result-total-m">M: ' + totalM + '</span>' +
        '</div>';
      resultText.innerHTML = html;
    }

    this.updateScoreDisplay();

    var nextBtn = document.getElementById('geoNextBtn');
    var submitBtn = document.getElementById('geoSubmitBtn');
    if (submitBtn) submitBtn.style.display = 'none';
    if (nextBtn) {
      if (this.state.round >= this.state.totalRounds) {
        nextBtn.style.display = 'none';
      } else {
        nextBtn.style.display = '';
        nextBtn.textContent = 'Next Round';
      }
    }
  }

  // =========================================================================
  //  NEXT ROUND
  // =========================================================================

  nextRound() {
    this._sendOp('geo_next', {gameId: this.state.gameId});
  }

  // =========================================================================
  //  SCORE DISPLAY
  // =========================================================================

  updateScoreDisplay() {
    var el = document.getElementById('geoScoreDisplay');
    if (!el) return;
    el.innerHTML = '<span class="geo-score-e">E: ' + (this.state.scores.E || 0) + '</span>' +
      '<span class="geo-score-sep"> \u2014 </span>' +
      '<span class="geo-score-m">M: ' + (this.state.scores.M || 0) + '</span>';
  }

  // =========================================================================
  //  RENDERING: GAME SUMMARY
  // =========================================================================

  renderGameSummary(data) {
    var guessArea = document.getElementById('geoGuessArea');
    var resultArea = document.getElementById('geoResultArea');
    var summaryArea = document.getElementById('geoSummaryArea');
    if (guessArea) guessArea.style.display = 'none';
    if (resultArea) resultArea.style.display = 'none';
    if (summaryArea) summaryArea.style.display = 'block';

    var isTie = data.winner === 'tie';
    var iWin = data.winner === Messages.myRole;
    var icon = isTie ? '\uD83E\uDD1D' : '\uD83C\uDFC6';
    var title = isTie ? "It's a tie!" : (iWin ? 'You win!' : data.winner + ' wins!');

    var html = '<div class="geo-summary-header">' +
      '<div class="geo-summary-icon">' + icon + '</div>' +
      '<div class="geo-summary-title">' + title + '</div>' +
      '</div>';

    var eTotal = data.totalScores.E || 0;
    var mTotal = data.totalScores.M || 0;
    html += '<div class="geo-summary-cards">' +
      '<div class="geo-summary-card geo-summary-card-e' + (data.winner === 'E' ? ' geo-summary-card-winner' : '') + '">' +
        '<div class="geo-sc-label">E</div>' +
        '<div class="geo-sc-score">' + eTotal + '</div>' +
      '</div>' +
      '<div class="geo-summary-vs">vs</div>' +
      '<div class="geo-summary-card geo-summary-card-m' + (data.winner === 'M' ? ' geo-summary-card-winner' : '') + '">' +
        '<div class="geo-sc-label">M</div>' +
        '<div class="geo-sc-score">' + mTotal + '</div>' +
      '</div>' +
      '</div>';

    html += '<div class="geo-summary-rounds">';
    (data.roundResults || []).forEach(function(rd) {
      var loc = rd.location || {};
      var eS = (rd.results && rd.results.E) ? rd.results.E.score : 0;
      var mS = (rd.results && rd.results.M) ? rd.results.M.score : 0;
      var rdWinner = eS > mS ? 'E' : (mS > eS ? 'M' : null);
      html += '<div class="geo-summary-round">' +
        '<span class="geo-sr-num">' + rd.round + '</span>' +
        '<span class="geo-sr-loc">' + (loc.name || '?') + '</span>' +
        '<span class="geo-sr-score geo-sr-e' + (rdWinner === 'E' ? ' geo-sr-won' : '') + '">' + (eS || '-') + '</span>' +
        '<span class="geo-sr-score geo-sr-m' + (rdWinner === 'M' ? ' geo-sr-won' : '') + '">' + (mS || '-') + '</span>' +
        '</div>';
    });
    html += '</div>';

    summaryArea.innerHTML = html;
  }

  // =========================================================================
  //  MOBILE VIEW TOGGLE
  // =========================================================================

  toggleMobileView() {
    var area = document.getElementById('geoGuessArea');
    var btn = document.getElementById('geoViewToggle');
    if (!area || !btn) return;
    if (area.classList.contains('show-map')) {
      area.classList.remove('show-map');
      btn.textContent = 'Guess Location';
    } else {
      area.classList.add('show-map');
      btn.textContent = 'Back to Street View';
      if (this.guessMap) google.maps.event.trigger(this.guessMap, 'resize');
    }
  }

  // =========================================================================
  //  SCOREBOARD  (override base class)
  // =========================================================================

  showScoreboard() {
    super.showScoreboard();
  }

  renderScoreboard(data) {
    // Show scoreboard in geo modal
    this.showModal();
    var guessArea = document.getElementById('geoGuessArea');
    var resultArea = document.getElementById('geoResultArea');
    var summaryArea = document.getElementById('geoSummaryArea');
    var scoreboardArea = document.getElementById('geoScoreboardArea');
    if (guessArea) guessArea.style.display = 'none';
    if (resultArea) resultArea.style.display = 'none';
    if (summaryArea) summaryArea.style.display = 'none';
    if (!scoreboardArea) return;
    scoreboardArea.style.display = 'block';
    this.state.phase = 'scoreboard';

    var roundLabel = document.getElementById('geoRoundLabel');
    if (roundLabel) roundLabel.textContent = 'GeoGuessr History';
    var scoreDisplay = document.getElementById('geoScoreDisplay');
    if (scoreDisplay) scoreDisplay.innerHTML = '';

    var html = '<div class="geo-scoreboard-stats">' +
      'E: ' + data.stats.eWins + ' wins &nbsp;|&nbsp; M: ' + data.stats.mWins + ' wins &nbsp;|&nbsp; Ties: ' + data.stats.ties +
      '</div>';

    if (!data.games || data.games.length === 0) {
      html += '<div style="text-align:center;color:var(--muted);padding:20px;">No games played yet</div>';
    } else {
      html += '<div class="geo-scoreboard-games">';
      data.games.forEach(function(g) {
        var date = new Date(g.started_at).toLocaleDateString();
        html += '<div class="geo-scoreboard-game">' +
          '<span class="geo-sg-date">' + date + '</span>' +
          '<span class="geo-sg-e">' + g.e_total_score + '</span>' +
          '<span style="color:var(--muted)">vs</span>' +
          '<span class="geo-sg-m">' + g.m_total_score + '</span>' +
          '<span class="geo-sg-winner">' + (g.winner === 'tie' ? 'Tie' : g.winner + ' won') + '</span>' +
          '</div>';
      });
      html += '</div>';
    }

    scoreboardArea.innerHTML = html;
  }

})({
  prefix:        'geo',
  icon:          '\uD83C\uDF0D',
  title:         'GeoGuessr',
  subtitle:      '5 rounds',
  modalId:       'geoModal',
  panelClass:    'geo-panel',
  showModal:     function() { UI.showGeoModal(); },
  hideModal:     function() { UI.hideGeoModal(); },
  scoreboardUrl: '/api/geo/scores/'
});
