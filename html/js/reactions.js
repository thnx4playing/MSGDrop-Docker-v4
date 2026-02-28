// ============================================================================
// REACTIONS.JS - Unified Message Actions Modal
// ============================================================================
// Features:
// 1. Emoji reactions row at top
// 2. Action buttons: View (for media), Reply, Edit, Delete
// 3. Clean iMessage-inspired design
// 4. Works on both tap and click
// ============================================================================

var Reactions = {
  currentTarget: null,
  currentSeq: null,
  currentMsg: null,

  setup: function(){
    this.createModal();
    
    document.addEventListener('click', function(e){
      var modal = document.getElementById('messageActionsModal');
      if(!modal) return;
      if(modal.contains(e.target)) return;
      this.closePicker();
    }.bind(this));
    
    document.addEventListener('keydown', function(e){
      if(e.key === 'Escape') this.closePicker();
    }.bind(this));
  },

  createModal: function(){
    var oldPicker = document.getElementById('reactPicker');
    if(oldPicker) oldPicker.remove();
    
    if(document.getElementById('messageActionsModal')) return;
    
    var modal = document.createElement('div');
    modal.id = 'messageActionsModal';
    modal.className = 'message-actions-modal';
    
    modal.innerHTML = `
      <div class="actions-modal-content">
        <div class="actions-emoji-row" id="actionsEmojiRow"></div>
        <div class="actions-divider"></div>
        <div class="actions-buttons-row" id="actionsButtonsRow">
          <button type="button" class="action-btn action-view" data-action="view" id="actionViewBtn" style="display:none;">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>
            <span>View</span>
          </button>
          <button type="button" class="action-btn action-reply" data-action="reply">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>
            <span>Reply</span>
          </button>
          <button type="button" class="action-btn action-edit" data-action="edit" id="actionEditBtn">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
            <span>Edit</span>
          </button>
          <button type="button" class="action-btn action-delete" data-action="delete">
            <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
            <span>Delete</span>
          </button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Setup emoji buttons
    var emojiRow = modal.querySelector('#actionsEmojiRow');
    CONFIG.REACTION_EMOJIS.forEach(function(emoji){
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action-emoji-btn';
      btn.textContent = emoji;
      btn.setAttribute('data-emoji', emoji);
      btn.addEventListener('click', function(e){
        e.stopPropagation();
        if(this.currentSeq !== null){
          this.reactToMessage(this.currentSeq, emoji, 'add');
        }
        this.closePicker();
      }.bind(this));
      emojiRow.appendChild(btn);
    }.bind(this));

    // "+" button to open full emoji picker for reactions
    var plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'action-emoji-btn action-emoji-plus';
    plusBtn.textContent = '+';
    plusBtn.addEventListener('click', function(e){
      e.stopPropagation();
      var seq = this.currentSeq;
      this.closePicker();
      if(typeof EmojiPicker !== 'undefined'){
        EmojiPicker.open('reaction', function(emoji){
          Reactions.reactToMessage(seq, emoji, 'add');
        });
      }
    }.bind(this));
    emojiRow.appendChild(plusBtn);

    // Setup action buttons
    var viewBtn = modal.querySelector('[data-action="view"]');
    var replyBtn = modal.querySelector('[data-action="reply"]');
    var editBtn = modal.querySelector('[data-action="edit"]');
    var deleteBtn = modal.querySelector('[data-action="delete"]');
    
    if(viewBtn){
      viewBtn.addEventListener('click', function(e){
        e.stopPropagation();
        if(this.currentMsg){
          var url = null;
          if(this.currentMsg.messageType === 'gif'){
            url = this.currentMsg.gifUrl;
          } else if(this.currentMsg.messageType === 'image'){
            url = this.currentMsg.imageUrl || this.currentMsg.imageThumb;
          }
          if(url && UI.openLightbox){
            UI.openLightbox(url + '?t=' + Date.now());
          } else if(url && UI.showLightbox){
            UI.showLightbox(url);
          }
        }
        this.closePicker();
      }.bind(this));
    }
    
    if(replyBtn){
      replyBtn.addEventListener('click', function(e){
        e.stopPropagation();
        if(this.currentSeq !== null){
          Messages.enterReplyMode(this.currentSeq);
        }
        this.closePicker();
      }.bind(this));
    }
    
    if(editBtn){
      editBtn.addEventListener('click', function(e){
        e.stopPropagation();
        if(this.currentSeq !== null && this.currentMsg){
          Messages.enterEditMode(this.currentSeq, this.currentMsg.message);
        }
        this.closePicker();
      }.bind(this));
    }
    
    if(deleteBtn){
      deleteBtn.addEventListener('click', function(e){
        e.stopPropagation();
        if(this.currentSeq !== null){
          var ok = confirm('Delete this message?');
          if(ok){
            App.deleteMessage(this.currentSeq);
          }
        }
        this.closePicker();
      }.bind(this));
    }
  },

  openPicker: function(msgEl){
    var modal = document.getElementById('messageActionsModal');
    if(!modal || !msgEl) return;
    
    var group = msgEl.closest('.message-group');
    if(!group) return;
    
    var seq = parseInt(group.getAttribute('data-seq'), 10);
    if(isNaN(seq)) return;
    
    this.currentTarget = group;
    this.currentSeq = seq;
    this.currentMsg = Messages.findMessageBySeq(seq);
    
    // Show/hide View button for GIFs and images
    var viewBtn = modal.querySelector('#actionViewBtn');
    if(viewBtn){
      if(this.currentMsg && (this.currentMsg.messageType === 'gif' || this.currentMsg.messageType === 'image')){
        viewBtn.style.display = 'flex';
      } else {
        viewBtn.style.display = 'none';
      }
    }
    
    // Show/hide Edit button (hide for GIFs and images)
    var editBtn = modal.querySelector('#actionEditBtn');
    if(editBtn){
      if(this.currentMsg && (this.currentMsg.messageType === 'gif' || this.currentMsg.messageType === 'image')){
        editBtn.style.display = 'none';
      } else {
        editBtn.style.display = 'flex';
      }
    }
    
    // Highlight existing reactions
    var emojiButtons = modal.querySelectorAll('.action-emoji-btn');
    emojiButtons.forEach(function(btn){
      btn.classList.remove('active');
      if(this.currentMsg && this.currentMsg.reactions){
        var emoji = btn.getAttribute('data-emoji');
        if(this.currentMsg.reactions[emoji] && this.currentMsg.reactions[emoji] > 0){
          btn.classList.add('active');
        }
      }
    }.bind(this));
    
    // Position the modal
    var rect = msgEl.getBoundingClientRect();
    modal.classList.add('show');
    
    requestAnimationFrame(function(){
      var modalWidth = modal.offsetWidth;
      var modalHeight = modal.offsetHeight;
      
      var left = rect.left + (rect.width / 2) - (modalWidth / 2);
      var top = rect.top - modalHeight - 12;
      
      if(top < 10){
        top = rect.bottom + 12;
      }
      
      if(left < 10) left = 10;
      if(left + modalWidth > window.innerWidth - 10){
        left = window.innerWidth - modalWidth - 10;
      }
      
      modal.style.left = left + 'px';
      modal.style.top = top + 'px';
    });
  },

  closePicker: function(){
    var modal = document.getElementById('messageActionsModal');
    if(modal){
      modal.classList.remove('show');
    }
    this.currentTarget = null;
    this.currentSeq = null;
    this.currentMsg = null;
  },

  render: function(container, reactions, seq){
    if(!container) return;
    container.innerHTML = '';
    
    if(!reactions || typeof reactions !== 'object') return;
    
    var reactionKeys = Object.keys(reactions);
    
    reactionKeys.forEach(function(emoji){
      var count = reactions[emoji];
      if(!count || count <= 0) return;
      
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'reaction-chip';
      
      if(count > 1){
        chip.textContent = emoji + ' ' + count;
        chip.style.minWidth = '36px';
        chip.style.paddingLeft = '6px';
        chip.style.paddingRight = '6px';
        chip.style.borderRadius = '12px';
      } else {
        chip.textContent = emoji;
      }
      
      chip.setAttribute('data-emoji', emoji);
      chip.setAttribute('data-seq', seq);
      chip.setAttribute('title', count > 1 ? 'Click to decrease (' + count + ')' : 'Click to remove');
      
      chip.addEventListener('click', function(e){
        e.stopPropagation();
        this.reactToMessage(seq, emoji, 'remove');
      }.bind(this));
      
      container.appendChild(chip);
    }.bind(this));
  },

  reactToMessage: async function(seq, emoji, op){
    if(!seq || !emoji) return;
    var dropId = encodeURIComponent(App.dropId);
    
    try{
      if(op === 'add'){
        var existingMsg = Messages.history.find(function(m){ return m.seq === seq; });
        if(existingMsg && existingMsg.reactions){
          var existingEmojis = Object.keys(existingMsg.reactions);
          for(var i = 0; i < existingEmojis.length; i++){
            var existing = existingEmojis[i];
            if(existing !== emoji && existingMsg.reactions[existing] > 0){
              await API.reactToMessage(dropId, seq, existing, 'remove');
            }
          }
        }
      }
      
      var res = await API.reactToMessage(dropId, seq, emoji, op);
      
      if(!res.ok){
        console.error('React failed:', res.status);
        return;
      }
      
      var data = await res.json();
      Messages.applyDrop(data);
      
    }catch(e){
      console.error('React error:', e);
    }
  }
};
