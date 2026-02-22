// Path: html/js/geogame.js
// ============================================================================
// GEOGAME.JS - GeoGuessr clone for MSGDrop v4
// ============================================================================

var GeoGame = {
  state: {
    gameId: null,
    round: 0,
    totalRounds: 5,
    phase: 'idle',       // idle | guessing | waiting | result | summary | scoreboard
    location: null,
    myGuess: null,
    otherPlayerGuessed: false,
    roundResult: null,
    scores: {E: 0, M: 0},
    roundHistory: [],
    otherPlayerHasGameOpen: false,
    timerInterval: null,
    timerSeconds: 60,
    pendingInviteId: null
  },

  panorama: null,
  guessMap: null,
  guessMarker: null,
  resultMap: null,
  mapsLoaded: false,
  _resultOverlays: [],

  // ─── Google Maps API loading ────────────────────────
  loadMapsAPI: function(callback) {
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
  },

  // ─── Game lifecycle ─────────────────────────────────
  startNewGame: function() {
    if (!Messages.myRole) { alert('Please select your role first'); return; }
    if (!WebSocketManager.ws || WebSocketManager.ws.readyState !== 1) {
      alert('Not connected to server'); return;
    }
    WebSocketManager.ws.send(JSON.stringify({
      action: 'game',
      payload: {op: 'geo_invite'}
    }));
    UI.hideGamesMenu();
  },

  acceptInvite: function() {
    if (!WebSocketManager.ws || WebSocketManager.ws.readyState !== 1) return;
    WebSocketManager.ws.send(JSON.stringify({
      action: 'game',
      payload: {op: 'geo_invite_accepted', inviteId: this.state.pendingInviteId}
    }));
  },

  declineInvite: function() {
    if (!WebSocketManager.ws || WebSocketManager.ws.readyState !== 1) return;
    WebSocketManager.ws.send(JSON.stringify({
      action: 'game',
      payload: {op: 'geo_invite_declined', inviteId: this.state.pendingInviteId}
    }));
  },

  cancelInvite: function() {
    if (!WebSocketManager.ws || WebSocketManager.ws.readyState !== 1) return;
    WebSocketManager.ws.send(JSON.stringify({
      action: 'game',
      payload: {op: 'geo_invite_cancelled', inviteId: this.state.pendingInviteId}
    }));
  },

  // ─── Incoming WS message router ────────────────────
  applyGame: function(data) {
    if (!data || !data.op) return;
    var op = data.op;

    if (op === 'geo_invite') {
      var fromPlayer = data.from;
      this.state.pendingInviteId = data.inviteId;
      if (fromPlayer === Messages.myRole) {
        // I sent the invite — show "waiting" status in chat
        if (typeof Messages !== 'undefined' && Messages.injectGeoInvite) {
          Messages.injectGeoInvite({id: data.inviteId, role: fromPlayer, status: 'waiting'});
        }
      } else {
        // Other player invited me — show accept/decline card
        if (typeof Messages !== 'undefined' && Messages.injectGeoInvite) {
          Messages.injectGeoInvite({id: data.inviteId, role: fromPlayer, status: 'incoming'});
        }
      }
      return;
    }
    else if (op === 'geo_invite_declined') {
      if (typeof Messages !== 'undefined' && Messages.updateGeoInvite) {
        Messages.updateGeoInvite(this.state.pendingInviteId, 'declined');
      }
      this.state.pendingInviteId = null;
      return;
    }
    else if (op === 'geo_invite_cancelled') {
      if (typeof Messages !== 'undefined' && Messages.updateGeoInvite) {
        Messages.updateGeoInvite(this.state.pendingInviteId, 'cancelled');
      }
      this.state.pendingInviteId = null;
      return;
    }

    if (op === 'geo_started') {
      // Clear the invite card when game starts
      if (this.state.pendingInviteId && typeof Messages !== 'undefined' && Messages.updateGeoInvite) {
        Messages.updateGeoInvite(this.state.pendingInviteId, 'starting');
      }
      this.state.pendingInviteId = null;
      this.state.gameId = data.gameId;
      this.state.round = data.round;
      this.state.totalRounds = data.totalRounds;
      this.state.location = data.location;
      this.state.phase = 'guessing';
      this.state.myGuess = null;
      this.state.otherPlayerGuessed = false;
      this.state.scores = {E: 0, M: 0};
      this.state.roundHistory = [];
      this.loadMapsAPI(function() {
        GeoGame.mapsLoaded = true;
        UI.showGeoModal();
        GeoGame.renderGuessing();
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
    else if (op === 'geo_forfeit') {
      if (data.player !== Messages.myRole) {
        this.state.phase = 'summary';
        this.renderForfeitMessage();
      }
    }
    else if (op === 'geo_player_opened') {
      if (data.player !== Messages.myRole) this.state.otherPlayerHasGameOpen = true;
    }
    else if (op === 'geo_player_closed') {
      if (data.player !== Messages.myRole) this.state.otherPlayerHasGameOpen = false;
    }
  },

  // ─── Rendering: Guessing Phase ──────────────────────
  renderGuessing: function() {
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
      sv.getPanorama({
        location: {lat: loc.lat, lng: loc.lng},
        radius: 500,
        source: google.maps.StreetViewSource.OUTDOOR
      }, function(data, status) {
        if (status === 'OK' && data && data.location && data.location.latLng) {
          GeoGame.panorama.setPosition(data.location.latLng);
        } else {
          GeoGame.panorama.setPosition({lat: loc.lat, lng: loc.lng});
        }
        GeoGame.panorama.setPov({heading: 0, pitch: 0});
        GeoGame.panorama.setZoom(0);
      });
    }

    // Guess mini-map
    var mapDiv = document.getElementById('geoGuessMap');
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
        GeoGame.placeGuess(e.latLng.lat(), e.latLng.lng());
      });
    } else {
      this.guessMap.setCenter({lat: 20, lng: 0});
      this.guessMap.setZoom(1);
    }

    // Clear old guess marker
    if (this.guessMarker) { this.guessMarker.setMap(null); this.guessMarker = null; }
    this.state.myGuess = null;
    this.updateGuessStatus();
    this.startTimer();
  },

  placeGuess: function(lat, lng) {
    if (this.state.phase !== 'guessing') return;
    this.state.myGuess = {lat: lat, lng: lng};
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
        GeoGame.state.myGuess = {lat: e.latLng.lat(), lng: e.latLng.lng()};
      });
    }
    var btn = document.getElementById('geoSubmitBtn');
    if (btn) btn.disabled = false;
  },

  submitGuess: function() {
    if (!this.state.myGuess || this.state.phase !== 'guessing') return;
    this.stopTimer();
    var btn = document.getElementById('geoSubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Waiting...'; }
    this.state.phase = 'waiting';
    WebSocketManager.ws.send(JSON.stringify({
      action: 'game',
      payload: {
        op: 'geo_guess',
        gameId: this.state.gameId,
        lat: this.state.myGuess.lat,
        lng: this.state.myGuess.lng
      }
    }));
    this.updateGuessStatus();
  },

  updateGuessStatus: function() {
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
  },

  // ─── Rendering: Round Result ────────────────────────
  renderRoundResult: function() {
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
    ['E', 'M'].forEach(function(p) {
      if (!data.results[p]) return;
      var r = data.results[p];
      var marker = new google.maps.Marker({
        position: {lat: r.guessLat, lng: r.guessLng},
        map: GeoGame.resultMap,
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
        map: GeoGame.resultMap
      });
      GeoGame._resultOverlays.push(marker, line);
      bounds.extend({lat: r.guessLat, lng: r.guessLng});
    });

    this.resultMap.fitBounds(bounds, 50);

    // Result text
    var resultText = document.getElementById('geoResultText');
    if (resultText) {
      // Determine round winner
      var eScore = (data.results.E && data.results.E.score) || 0;
      var mScore = (data.results.M && data.results.M.score) || 0;
      var roundWinner = eScore > mScore ? 'E' : (mScore > eScore ? 'M' : null);

      var html = '<div class="geo-result-location">' + loc.name + ', ' + loc.country + '</div>';
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
  },

  nextRound: function() {
    WebSocketManager.ws.send(JSON.stringify({
      action: 'game',
      payload: {op: 'geo_next', gameId: this.state.gameId}
    }));
  },

  updateScoreDisplay: function() {
    var el = document.getElementById('geoScoreDisplay');
    if (!el) return;
    el.innerHTML = '<span class="geo-score-e">E: ' + (this.state.scores.E || 0) + '</span>' +
      '<span class="geo-score-sep"> \u2014 </span>' +
      '<span class="geo-score-m">M: ' + (this.state.scores.M || 0) + '</span>';
  },

  // ─── Rendering: Game Summary ────────────────────────
  renderGameSummary: function(data) {
    var guessArea = document.getElementById('geoGuessArea');
    var resultArea = document.getElementById('geoResultArea');
    var summaryArea = document.getElementById('geoSummaryArea');
    if (guessArea) guessArea.style.display = 'none';
    if (resultArea) resultArea.style.display = 'none';
    if (summaryArea) summaryArea.style.display = 'block';

    var html = '<div class="geo-summary-title">';
    if (data.winner === 'tie') html += "It's a tie!";
    else if (data.winner === Messages.myRole) html += 'You win!';
    else html += data.winner + ' wins!';
    html += '</div>';

    html += '<div class="geo-summary-scores">' +
      '<div class="geo-summary-player' + (data.winner === 'E' ? ' winner' : '') + '">E: ' + data.totalScores.E + '</div>' +
      '<div class="geo-summary-player' + (data.winner === 'M' ? ' winner' : '') + '">M: ' + data.totalScores.M + '</div>' +
      '</div>';

    html += '<div class="geo-summary-rounds">';
    (data.roundResults || []).forEach(function(rd) {
      var loc = rd.location || {};
      html += '<div class="geo-summary-round">' +
        '<span class="geo-sr-num">R' + rd.round + '</span>' +
        '<span class="geo-sr-loc">' + (loc.name || loc.country || '?') + '</span>' +
        '<span class="geo-sr-e">' + ((rd.results && rd.results.E) ? rd.results.E.score : '-') + '</span>' +
        '<span class="geo-sr-m">' + ((rd.results && rd.results.M) ? rd.results.M.score : '-') + '</span>' +
        '</div>';
    });
    html += '</div>';

    summaryArea.innerHTML = html;
  },

  renderForfeitMessage: function() {
    var guessArea = document.getElementById('geoGuessArea');
    var resultArea = document.getElementById('geoResultArea');
    var summaryArea = document.getElementById('geoSummaryArea');
    if (guessArea) guessArea.style.display = 'none';
    if (resultArea) resultArea.style.display = 'none';
    if (summaryArea) {
      summaryArea.style.display = 'block';
      summaryArea.innerHTML = '<div class="geo-summary-title">Other player left the game</div>';
    }
  },

  // ─── Close / Forfeit ────────────────────────────────
  closeGame: function() {
    if (this.state.phase === 'guessing' || this.state.phase === 'waiting' || this.state.phase === 'result') {
      if (!confirm('Leave the game? This will forfeit.')) return;
      WebSocketManager.ws.send(JSON.stringify({
        action: 'game',
        payload: {op: 'geo_forfeit', gameId: this.state.gameId}
      }));
    }
    this.resetState();
    UI.hideGeoModal();
  },

  resetState: function() {
    this.stopTimer();
    this.state.gameId = null;
    this.state.phase = 'idle';
    this.state.round = 0;
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
  },

  // ─── Timer management ─────────────────────────────
  startTimer: function() {
    this.stopTimer();
    this.state.timerSeconds = 60;
    var timerEl = document.getElementById('geoTimer');
    if (timerEl) { timerEl.textContent = '1:00'; timerEl.classList.remove('warning'); }
    var self = this;
    this.state.timerInterval = setInterval(function() {
      self.state.timerSeconds--;
      var s = self.state.timerSeconds;
      var timerEl = document.getElementById('geoTimer');
      if (timerEl) {
        var min = Math.floor(s / 60);
        var sec = s % 60;
        timerEl.textContent = min + ':' + (sec < 10 ? '0' : '') + sec;
        if (s <= 10) timerEl.classList.add('warning');
        else timerEl.classList.remove('warning');
      }
      if (s <= 0) {
        self.stopTimer();
        if (self.state.phase === 'guessing') {
          if (!self.state.myGuess) {
            // Auto-guess center of map
            var center = self.guessMap ? self.guessMap.getCenter() : {lat: function(){return 20;}, lng: function(){return 0;}};
            self.placeGuess(center.lat(), center.lng());
          }
          self.submitGuess();
        }
      }
    }, 1000);
  },

  stopTimer: function() {
    if (this.state.timerInterval) {
      clearInterval(this.state.timerInterval);
      this.state.timerInterval = null;
    }
  },

  // ─── Mobile view toggle ────────────────────────────
  toggleMobileView: function() {
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
  },

  // ─── Scoreboard ─────────────────────────────────────
  showScoreboard: function() {
    var dropId = App.dropId;
    fetch('/api/geo/scores/' + encodeURIComponent(dropId), {credentials: 'include'})
      .then(function(r) { return r.json(); })
      .then(function(data) { GeoGame.renderScoreboard(data); })
      .catch(function(e) { console.error('[GeoGame] Failed to load scores:', e); });
  },

  renderScoreboard: function(data) {
    // Show scoreboard in geo modal
    UI.showGeoModal();
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
};
