// ==========================================================================
// TDR空調設備 現場リスト管理ツール - アプリケーションロジック
// ==========================================================================

const APP_DB_NAME = 'TDR_HVAC_FieldDB';
const APP_DB_VERSION = 1;
const STORE_NAME = 'records';
const CANDIDATES_STORAGE_KEY = 'TDR_HVAC_UserCaptions_v2';

class HVACApp {
  constructor() {
    this.db = null;
    this.records = [];
    
    // 写真スロット（入口 / 部屋 / 機器）
    this.currentPhotos = {
      entrance: [],  // 建物・エリア入口写真
      room: [],      // 部屋・機械室写真
      equipment: []  // 対象機・フィルター写真
    };

    this.editingId = null;
    this.manualArea = false;
    this.manualFacility = false;
    this.selectedPark = 'TDS';

    // 候補チップの編集モード状態
    this.chipEditState = {
      area: false,
      facility: false,
      floor: false,
      room: false,
      access: false,
      equipment: false
    };

    // ユーザー自身が管理するキャプションデータ（初期デフォルトは全てなし・空配列）
    this.candidates = this.loadCandidates();
  }

  // 初期化
  async init() {
    await this.initDB();
    this.setupUI();
    this.bindEvents();
    await this.loadRecords();
    this.updateParkAreas();
    this.updateTotalUnits();
  }

  // ================= 1. よく使うキャプション管理 (ユーザー自身で追加・削除) =================
  loadCandidates() {
    // 過去バージョンの不要な古いストレージをクリーンアップ
    ['TDR_HVAC_CustomCandidates_v1', 'TDR_HVAC_CustomCandidates_v2', 'TDR_HVAC_CustomCandidates_v3', 'TDR_HVAC_CustomCandidates_v4'].forEach(k => {
      try { localStorage.removeItem(k); } catch (e) {}
    });

    // デフォルトの初期候補はすべてなし（空）。ユーザーが追加した項目のみ保持
    const defaultData = {
      area: [],
      facility: [],
      floor: [],
      room: [],
      access: [],
      equipment: []
    };

    try {
      const saved = localStorage.getItem(CANDIDATES_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          area: Array.isArray(parsed.area) ? parsed.area : [],
          facility: Array.isArray(parsed.facility) ? parsed.facility : [],
          floor: Array.isArray(parsed.floor) ? parsed.floor : [],
          room: Array.isArray(parsed.room) ? parsed.room : (Array.isArray(parsed.room?.global) ? parsed.room.global : []),
          access: Array.isArray(parsed.access) ? parsed.access : (Array.isArray(parsed.access?.global) ? parsed.access.global : []),
          equipment: Array.isArray(parsed.equipment) ? parsed.equipment : (Array.isArray(parsed.equipment?.global) ? parsed.equipment.global : [])
        };
      }
    } catch (e) {
      console.warn('Failed to load user captions:', e);
    }
    return defaultData;
  }

  saveCandidates() {
    try {
      localStorage.setItem(CANDIDATES_STORAGE_KEY, JSON.stringify(this.candidates));
    } catch (e) {
      console.warn('Failed to save user captions:', e);
    }
  }

  addCandidate(type, val) {
    const trimmed = (val || '').trim();
    if (!trimmed) return;

    if (!Array.isArray(this.candidates[type])) {
      this.candidates[type] = [];
    }

    if (!this.candidates[type].includes(trimmed)) {
      this.candidates[type].unshift(trimmed);
    }

    this.saveCandidates();
    this.renderAllChips();

    if (type === 'area') {
      this.updateParkAreas();
    } else if (type === 'facility') {
      this.updateAreaFacilities();
    }

    this.showToast(`「${trimmed}」を候補に追加しました`);
  }

  removeCandidate(type, val) {
    if (!Array.isArray(this.candidates[type])) return;

    this.candidates[type] = this.candidates[type].filter(item => item !== val);
    this.saveCandidates();
    this.renderAllChips();

    if (type === 'area') {
      this.updateParkAreas();
    } else if (type === 'facility') {
      this.updateAreaFacilities();
    }

    this.showToast(`候補「${val}」を削除しました`);
  }

  renderAllChips() {
    this.renderChipsForType('area', 'area-chips', 'area-select');
    this.renderChipsForType('facility', 'facility-chips', 'facility-select');
    this.renderChipsForType('floor', 'floor-chips', 'floor-input');
    this.renderChipsForType('room', 'room-chips', 'room-input');
    this.renderChipsForType('access', 'access-chips', 'access-input');
    this.renderChipsForType('equipment', 'equipment-chips', 'equipment-input');
  }

  renderChipsForType(type, containerId, targetInputId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const list = this.candidates[type] || [];
    const isEditing = this.chipEditState[type];

    if (list.length === 0) {
      container.innerHTML = '<span class="text-xs text-muted">登録済みの候補はありません（＋追加ボタンから登録できます）</span>';
      return;
    }

    container.innerHTML = list.map(item => {
      const deleteBtnHtml = isEditing ? `<button type="button" class="chip-delete-btn" data-type="${type}" data-val="${this.escapeHtml(item)}">✕</button>` : '';

      return `
        <button type="button" class="chip" data-target="${targetInputId}" data-val="${this.escapeHtml(item)}">
          <span>${this.escapeHtml(item)}</span>
          ${deleteBtnHtml}
        </button>
      `;
    }).join('');
  }

  openCandidateModal(type) {
    const modal = document.getElementById('candidate-modal');
    document.getElementById('candidate-type').value = type;
    document.getElementById('candidate-input-val').value = '';

    const titles = {
      area: 'エリア / テーマポート の候補を追加',
      facility: '施設 / アトラクション の候補を追加',
      floor: '階層（1Fなど） の候補を追加',
      room: '部屋名 の候補を追加',
      access: 'アクセス方法 のタグを追加',
      equipment: '作業に必要なもの のタグを追加'
    };
    document.getElementById('candidate-modal-title').textContent = titles[type] || '候補を追加';

    modal.classList.remove('hidden');
    setTimeout(() => {
      document.getElementById('candidate-input-val').focus();
    }, 150);
  }

  // ================= 2. 空調機台数ステッパー計算 =================
  updateTotalUnits() {
    const cCas = parseInt(document.getElementById('pac-cassette-count')?.value || '0', 10) || 0;
    const cFloor = parseInt(document.getElementById('pac-floor-count')?.value || '0', 10) || 0;
    const cCeil = parseInt(document.getElementById('pac-ceiling-count')?.value || '0', 10) || 0;
    const cWall = parseInt(document.getElementById('pac-wall-count')?.value || '0', 10) || 0;
    const cOther = parseInt(document.getElementById('pac-other-count')?.value || '0', 10) || 0;

    const pacSubtypes = {
      cassette: cCas,
      floor: cFloor,
      ceiling: cCeil,
      wall: cWall,
      other: cOther
    };

    const pacTotal = cCas + cFloor + cCeil + cWall + cOther;
    const hex = parseInt(document.getElementById('hex-count')?.value || '0', 10) || 0;
    const fcu = parseInt(document.getElementById('fcu-count')?.value || '0', 10) || 0;

    const total = pacTotal + hex + fcu;

    const pacBadge = document.getElementById('pac-subtotal-badge');
    if (pacBadge) {
      pacBadge.textContent = `PAC計: ${pacTotal}台`;
    }

    const badge = document.getElementById('total-units-badge');
    if (badge) {
      badge.textContent = `合計: ${total}台`;
    }

    return { pac: pacTotal, pacSubtypes, hex, fcu, total };
  }

  // ================= 3. IndexedDB データベース層 =================
  initDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(APP_DB_NAME, APP_DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('park', 'park', { unique: false });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      request.onerror = (e) => {
        console.error('IndexedDB open error:', e);
        this.showToast('データベースの起動に失敗しました', true);
        reject(e);
      };
    });
  }

  async loadRecords() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        this.records = (request.result || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        this.updateHeaderBadge();
        this.renderRecordsList();
        this.renderSpreadsheetPreview();
        this.renderReportCards();
        resolve(this.records);
      };

      request.onerror = (e) => {
        console.error('Failed to load records:', e);
        reject(e);
      };
    });
  }

  async saveRecord(record) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(record);

      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e);
    });
  }

  async deleteRecord(id) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = (e) => reject(e);
    });
  }

  // ================= 4. UIイベント登録 =================
  setupUI() {
    this.renderAllChips();
    this.renderAllPhotoSlots();
  }

  bindEvents() {
    // タブ切り替え
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    // パーク選択
    document.querySelectorAll('.park-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.park-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.selectedPark = btn.dataset.park;
        this.updateParkAreas();
        this.updatePathPreview();
        this.renderAllChips();
      });
    });

    // エリア変更
    document.getElementById('area-select').addEventListener('change', (e) => {
      if (e.target.value === '__MANUAL__') {
        this.setManualArea(true);
        setTimeout(() => document.getElementById('area-manual').focus(), 50);
      } else {
        this.manualArea = false;
        this.updateAreaFacilities();
        this.updatePathPreview();
        this.renderAllChips();
      }
    });

    // エリア手入力切替
    document.getElementById('toggle-manual-area').addEventListener('click', () => {
      this.setManualArea(!this.manualArea);
      if (this.manualArea) {
        setTimeout(() => document.getElementById('area-manual').focus(), 50);
      }
      this.updateAreaFacilities();
      this.updatePathPreview();
      this.renderAllChips();
    });

    document.getElementById('area-manual').addEventListener('input', () => {
      this.updateAreaFacilities();
      this.updatePathPreview();
      this.renderAllChips();
    });

    // 施設検索
    document.getElementById('facility-filter').addEventListener('input', (e) => {
      this.filterFacilities(e.target.value);
    });

    // 施設変更
    document.getElementById('facility-select').addEventListener('change', (e) => {
      if (e.target.value === '__MANUAL__') {
        this.setManualFacility(true);
        setTimeout(() => document.getElementById('facility-manual').focus(), 50);
      } else {
        this.manualFacility = false;
        this.updatePathPreview();
        this.renderAllChips();
      }
    });

    // 施設手入力切替
    document.getElementById('toggle-manual-facility').addEventListener('click', () => {
      this.setManualFacility(!this.manualFacility);
      if (this.manualFacility) {
        setTimeout(() => document.getElementById('facility-manual').focus(), 50);
      }
      this.updatePathPreview();
      this.renderAllChips();
    });

    document.getElementById('facility-manual').addEventListener('input', () => {
      this.updatePathPreview();
      this.renderAllChips();
    });

    document.getElementById('floor-input')?.addEventListener('input', () => {
      this.updatePathPreview();
    });

    document.getElementById('room-input').addEventListener('input', () => {
      this.updatePathPreview();
    });

    // ステッパーボタン操作（＋ / －）
    document.querySelectorAll('.btn-step').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        const targetId = btn.dataset.target;
        const input = document.getElementById(targetId);
        if (!input) return;

        let cur = parseInt(input.value || '0', 10);
        if (action === 'inc') {
          cur = Math.min(99, cur + 1);
        } else if (action === 'dec') {
          cur = Math.max(0, cur - 1);
        }
        input.value = cur;
        this.updateTotalUnits();
      });
    });

    // ステッパーインプット直接変更
    ['pac-cassette-count', 'pac-floor-count', 'pac-ceiling-count', 'pac-wall-count', 'pac-other-count', 'hex-count', 'fcu-count'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => this.updateTotalUnits());
      }
    });

    // 候補追加ボタン
    ['area', 'facility', 'floor', 'room', 'access', 'equipment'].forEach(type => {
      const btn = document.getElementById(`add-${type}-chip-btn`);
      if (btn) {
        btn.addEventListener('click', () => this.openCandidateModal(type));
      }
    });

    // 候補編集モード切替ボタン
    const bindEditToggle = (btnId, type) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        this.chipEditState[type] = !this.chipEditState[type];
        btn.classList.toggle('active-edit', this.chipEditState[type]);
        btn.textContent = this.chipEditState[type] ? '完了' : '⚙️ 編集';
        const targetInputId = (type === 'area' || type === 'facility') ? `${type}-select` : `${type}-input`;
        this.renderChipsForType(type, `${type}-chips`, targetInputId);
      });
    };
    bindEditToggle('toggle-edit-area-chip-btn', 'area');
    bindEditToggle('toggle-edit-facility-chip-btn', 'facility');
    bindEditToggle('toggle-edit-floor-chip-btn', 'floor');
    bindEditToggle('toggle-edit-room-chip-btn', 'room');
    bindEditToggle('toggle-edit-access-chip-btn', 'access');
    bindEditToggle('toggle-edit-equipment-chip-btn', 'equipment');

    // 候補モーダル閉じる
    document.getElementById('close-candidate-modal').addEventListener('click', () => {
      document.getElementById('candidate-modal').classList.add('hidden');
    });

    // 候補モーダル保存
    document.getElementById('save-candidate-btn').addEventListener('click', () => {
      const type = document.getElementById('candidate-type').value;
      const val = document.getElementById('candidate-input-val').value.trim();

      if (!val) {
        this.showToast('名前を入力してください', true);
        return;
      }

      this.addCandidate(type, val);
      document.getElementById('candidate-modal').classList.add('hidden');
    });

    // チップクリック & チップ削除
    document.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.chip-delete-btn');
      if (delBtn) {
        e.stopPropagation();
        const type = delBtn.dataset.type;
        const val = delBtn.dataset.val;
        this.removeCandidate(type, val);
        return;
      }

      const chip = e.target.closest('.chip');
      if (!chip) return;

      const targetId = chip.dataset.target;
      const val = chip.dataset.val;
      const input = document.getElementById(targetId);

      // エリアチップの選択
      if (targetId === 'area-select') {
        this.setManualArea(false);
        const sel = document.getElementById('area-select');
        if (sel) {
          sel.value = val;
          // もしoptionに存在しなければ追加して選択
          if (sel.value !== val) {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = val;
            sel.insertBefore(opt, sel.lastElementChild);
            sel.value = val;
          }
        }
        document.getElementById('area-manual').value = val;
        this.updateAreaFacilities();
        this.updatePathPreview();
        this.renderAllChips();
        return;
      }

      // 施設チップの選択
      if (targetId === 'facility-select') {
        this.setManualFacility(false);
        const sel = document.getElementById('facility-select');
        if (sel) {
          sel.value = val;
          if (sel.value !== val) {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = val;
            sel.insertBefore(opt, sel.lastElementChild);
            sel.value = val;
          }
        }
        document.getElementById('facility-manual').value = val;
        this.updatePathPreview();
        this.renderAllChips();
        return;
      }

      if (!input) return;

      if (targetId === 'room-input' || targetId === 'floor-input') {
        input.value = val;
      } else {
        const cur = input.value.trim();
        if (cur.length === 0) {
          input.value = val;
        } else if (!cur.includes(val)) {
          input.value = `${cur} ${val}`;
        }
      }
      input.dispatchEvent(new Event('input'));
    });

    // 写真スロット入力イベント
    const bindPhotoSlot = (inputId, slotType) => {
      const el = document.getElementById(inputId);
      if (el) {
        el.addEventListener('change', (e) => this.handlePhotoUploadForSlot(slotType, e));
      }
    };
    bindPhotoSlot('camera-entrance', 'entrance');
    bindPhotoSlot('album-entrance', 'entrance');
    bindPhotoSlot('camera-room', 'room');
    bindPhotoSlot('album-room', 'room');
    bindPhotoSlot('camera-equipment', 'equipment');
    bindPhotoSlot('album-equipment', 'equipment');

    // フォーム保存
    document.getElementById('record-form').addEventListener('submit', (e) => this.handleFormSubmit(e));
    document.getElementById('cancel-edit-btn').addEventListener('click', () => this.resetForm());

    // リスト検索・フィルター
    document.getElementById('list-search-input').addEventListener('input', () => this.renderRecordsList());
    document.getElementById('clear-search-btn').addEventListener('click', () => {
      document.getElementById('list-search-input').value = '';
      this.renderRecordsList();
    });
    document.getElementById('filter-park-select').addEventListener('change', () => this.renderRecordsList());
    document.getElementById('filter-equipment-select').addEventListener('change', () => this.renderRecordsList());
    document.getElementById('scroll-to-top-btn').addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // スプレッドシート出力
    document.getElementById('copy-tsv-btn').addEventListener('click', () => this.copyToClipboardTSV());
    document.getElementById('download-csv-btn').addEventListener('click', () => this.downloadCSV());
    document.getElementById('download-xlsx-btn').addEventListener('click', () => this.downloadXLSX());
    document.getElementById('export-json-btn').addEventListener('click', () => this.exportJSON());
    document.getElementById('import-json-input').addEventListener('change', (e) => this.importJSON(e));

    // 印刷
    document.getElementById('print-report-btn').addEventListener('click', () => window.print());

    // 写真拡大モーダル
    document.getElementById('close-modal-btn').addEventListener('click', () => {
      document.getElementById('photo-modal').classList.add('hidden');
    });
    document.getElementById('photo-modal').addEventListener('click', (e) => {
      if (e.target.id === 'photo-modal') {
        document.getElementById('photo-modal').classList.add('hidden');
      }
    });

    // 共有QRコードモーダル
    const openShareBtn = document.getElementById('open-share-qr-btn');
    if (openShareBtn) {
      openShareBtn.addEventListener('click', () => this.openShareQRModal());
    }
    const closeShareBtn = document.getElementById('close-share-qr-modal');
    if (closeShareBtn) {
      closeShareBtn.addEventListener('click', () => this.closeShareQRModal());
    }
    const doneShareBtn = document.getElementById('done-share-qr-btn');
    if (doneShareBtn) {
      doneShareBtn.addEventListener('click', () => this.closeShareQRModal());
    }
    const shareModal = document.getElementById('share-qr-modal');
    if (shareModal) {
      shareModal.addEventListener('click', (e) => {
        if (e.target.id === 'share-qr-modal') this.closeShareQRModal();
      });
    }
    const copyShareBtn = document.getElementById('copy-share-url-btn');
    if (copyShareBtn) {
      copyShareBtn.addEventListener('click', () => this.copyShareUrl());
    }
  }

  // 共有QRコード表示
  openShareQRModal() {
    const modal = document.getElementById('share-qr-modal');
    if (!modal) return;

    let shareUrl = window.location.href.split('#')[0];
    if (shareUrl.startsWith('file:') || shareUrl.includes('localhost') || shareUrl.includes('127.0.0.1')) {
      shareUrl = 'https://frs0882-byte.github.io/tdr-hvac-field/';
    }

    const urlInput = document.getElementById('share-url-input');
    if (urlInput) urlInput.value = shareUrl;

    const qrContainer = document.getElementById('share-qr-code');
    if (qrContainer) {
      qrContainer.innerHTML = '';
      if (typeof QRCode !== 'undefined') {
        new QRCode(qrContainer, {
          text: shareUrl,
          width: 200,
          height: 200,
          colorDark: '#0f172a',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      } else {
        qrContainer.innerHTML = '<span class="text-xs text-muted">QRコード生成中...</span>';
      }
    }

    modal.classList.remove('hidden');
  }

  closeShareQRModal() {
    const modal = document.getElementById('share-qr-modal');
    if (modal) modal.classList.add('hidden');
  }

  async copyShareUrl() {
    const input = document.getElementById('share-url-input');
    if (!input || !input.value) return;

    try {
      await navigator.clipboard.writeText(input.value);
      this.showToast('📋 共有URLをコピーしました！');
    } catch (e) {
      this.fallbackCopyText(input.value);
    }
  }

  // ================= 5. 写真撮影 & スロット管理 =================
  async handlePhotoUploadForSlot(slotType, e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    this.showToast('写真を最適化して保存中...');

    const labels = {
      entrance: '建物入口',
      room: '部屋・室内',
      equipment: '対象機器'
    };

    for (const file of files) {
      try {
        const resizedBase64 = await this.resizeImage(file, 1280, 0.82);
        const photoObj = {
          id: 'photo_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          dataUrl: resizedBase64,
          label: labels[slotType] || '現場写真',
          slot: slotType,
          timestamp: new Date().toISOString()
        };
        this.currentPhotos[slotType].push(photoObj);
      } catch (err) {
        console.error('Image resize error:', err);
        this.showToast('写真の処理に失敗しました', true);
      }
    }

    e.target.value = '';
    this.renderAllPhotoSlots();
  }

  resizeImage(file, maxDimension = 1280, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);

          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = e.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  renderAllPhotoSlots() {
    this.renderSlotGrid('entrance', 'entrance-preview-grid');
    this.renderSlotGrid('room', 'room-preview-grid');
    this.renderSlotGrid('equipment', 'equipment-preview-grid');
  }

  renderSlotGrid(slotType, gridId) {
    const grid = document.getElementById(gridId);
    if (!grid) return;

    const photos = this.currentPhotos[slotType] || [];
    if (photos.length === 0) {
      grid.innerHTML = '<p class="text-xs text-muted" style="grid-column: 1/-1;">未撮影（カメラまたはアルバムから登録）</p>';
      return;
    }

    grid.innerHTML = photos.map((p, idx) => `
      <div class="photo-card" data-slot="${slotType}" data-idx="${idx}">
        <img src="${p.dataUrl}" alt="${p.label}" onclick="app.showModalPhoto('${p.dataUrl}', '${p.label}')">
        <span class="photo-type-tag">${p.label}</span>
        <button type="button" class="photo-delete-btn" onclick="app.removePhotoFromSlot('${slotType}', ${idx})">✕</button>
      </div>
    `).join('');
  }

  removePhotoFromSlot(slotType, index) {
    if (this.currentPhotos[slotType]) {
      this.currentPhotos[slotType].splice(index, 1);
      this.renderSlotGrid(slotType, `${slotType}-preview-grid`);
    }
  }

  showModalPhoto(dataUrl, caption) {
    const modal = document.getElementById('photo-modal');
    document.getElementById('modal-img').src = dataUrl;
    document.getElementById('modal-caption').textContent = caption || '';
    modal.classList.remove('hidden');
  }

  // ================= 6. 階層ドリルダウン & 自由入力切替 =================
  setManualArea(isManual) {
    this.manualArea = isManual;
    const selectBox = document.getElementById('area-select');
    const manualInput = document.getElementById('area-manual');
    const toggleBtn = document.getElementById('toggle-manual-area');

    if (this.manualArea) {
      selectBox.classList.add('hidden');
      manualInput.classList.remove('hidden');
      if (toggleBtn) toggleBtn.textContent = '📋 リスト選択に戻す';
    } else {
      selectBox.classList.remove('hidden');
      manualInput.classList.add('hidden');
      if (toggleBtn) toggleBtn.textContent = '✏️ 自由入力に切替';
    }
  }

  setManualFacility(isManual) {
    this.manualFacility = isManual;
    const selectBox = document.getElementById('facility-select-container');
    const manualInput = document.getElementById('facility-manual');
    const toggleBtn = document.getElementById('toggle-manual-facility');

    if (this.manualFacility) {
      selectBox.classList.add('hidden');
      manualInput.classList.remove('hidden');
      if (toggleBtn) toggleBtn.textContent = '📋 リスト選択に戻す';
    } else {
      selectBox.classList.remove('hidden');
      manualInput.classList.add('hidden');
      if (toggleBtn) toggleBtn.textContent = '✏️ 自由入力に切替';
    }
  }

  getCurrentAreaName() {
    if (this.manualArea) {
      return document.getElementById('area-manual').value.trim();
    }
    const val = document.getElementById('area-select').value;
    if (val === '__MANUAL__' || !val) {
      return document.getElementById('area-manual').value.trim();
    }
    return val;
  }

  getCurrentFacilityName() {
    if (this.manualFacility) {
      return document.getElementById('facility-manual').value.trim();
    }
    const val = document.getElementById('facility-select').value;
    if (val === '__MANUAL__' || !val) {
      return document.getElementById('facility-manual').value.trim();
    }
    return val;
  }

  updateParkAreas() {
    const areaSelect = document.getElementById('area-select');
    const manualInput = document.getElementById('area-manual');
    const toggleBtn = document.getElementById('toggle-manual-area');
    const areas = this.candidates.area || [];

    if (toggleBtn) toggleBtn.classList.remove('hidden');

    let optionsHtml = '<option value="">(エリアを選択)</option>';
    optionsHtml += areas.map(area => `<option value="${this.escapeHtml(area)}">${this.escapeHtml(area)}</option>`).join('');
    optionsHtml += '<option value="__MANUAL__">✏️ ＋ 新規エリアを直接手入力...</option>';
    areaSelect.innerHTML = optionsHtml;

    const cur = this.manualArea ? manualInput.value.trim() : areaSelect.value;
    if (cur && areas.includes(cur)) {
      areaSelect.value = cur;
    }

    if (this.manualArea) {
      areaSelect.classList.add('hidden');
      manualInput.classList.remove('hidden');
    } else {
      areaSelect.classList.remove('hidden');
      manualInput.classList.add('hidden');
    }

    this.updateAreaFacilities();
    this.updatePathPreview();
    this.renderAllChips();
  }

  updateAreaFacilities() {
    const facSelect = document.getElementById('facility-select');
    const facContainer = document.getElementById('facility-select-container');
    const manualInput = document.getElementById('facility-manual');
    const toggleBtn = document.getElementById('toggle-manual-facility');
    const facilities = this.candidates.facility || [];

    if (toggleBtn) toggleBtn.classList.remove('hidden');

    let optionsHtml = '<option value="">(施設を選択)</option>';
    optionsHtml += facilities.map(f => `<option value="${this.escapeHtml(f)}">${this.escapeHtml(f)}</option>`).join('');
    optionsHtml += '<option value="__MANUAL__">✏️ ＋ 新規施設を直接手入力...</option>';
    facSelect.innerHTML = optionsHtml;

    const cur = this.manualFacility ? manualInput.value.trim() : facSelect.value;
    if (cur && facilities.includes(cur)) {
      facSelect.value = cur;
    }

    if (this.manualFacility) {
      facContainer.classList.add('hidden');
      manualInput.classList.remove('hidden');
    } else {
      facContainer.classList.remove('hidden');
      manualInput.classList.add('hidden');
    }

    this.updatePathPreview();
    this.renderAllChips();
  }

  filterFacilities(query) {
    const facilities = this.candidates.facility || [];
    const q = (query || '').trim().toLowerCase();
    const filtered = q ? facilities.filter(f => f.toLowerCase().includes(q)) : facilities;

    const facSelect = document.getElementById('facility-select');
    let optionsHtml = '<option value="">(施設を選択)</option>';
    optionsHtml += filtered.map(f => `<option value="${this.escapeHtml(f)}">${this.escapeHtml(f)}</option>`).join('');
    optionsHtml += '<option value="__MANUAL__">✏️ ＋ 新規施設を直接手入力...</option>';
    facSelect.innerHTML = optionsHtml;

    if (filtered.length > 0) {
      facSelect.value = filtered[0];
    }
    this.updatePathPreview();
    this.renderAllChips();
  }

  updatePathPreview() {
    const parkName = this.selectedPark;
    const area = this.getCurrentAreaName() || '(エリア未入力)';
    const facility = this.getCurrentFacilityName() || '(施設未入力)';
    const floor = document.getElementById('floor-input')?.value.trim() || '(階層未入力)';
    const room = document.getElementById('room-input')?.value.trim() || '(部屋未入力)';

    const path = `TDR → ${parkName} → ${area} → ${facility} → ${floor} → ${room}`;
    const displayEl = document.getElementById('current-path-display');
    if (displayEl) {
      displayEl.textContent = path;
    }
  }

  // ================= 7. フォーム送信・データ保存 =================
  async handleFormSubmit(e) {
    e.preventDefault();

    const park = this.selectedPark;
    const area = this.getCurrentAreaName();
    const facility = this.getCurrentFacilityName();
    const floor = document.getElementById('floor-input')?.value.trim() || '';
    const room = document.getElementById('room-input').value.trim();

    if (!floor) {
      this.showToast('階層（1Fなど）を入力してください', true);
      document.getElementById('floor-input')?.focus();
      return;
    }

    if (!room) {
      this.showToast('部屋名を入力してください', true);
      document.getElementById('room-input').focus();
      return;
    }

    const { pac, pacSubtypes, hex, fcu, total } = this.updateTotalUnits();
    const otherEquipment = document.getElementById('other-equip-input')?.value.trim() || '';

    // 機種サマリー文の生成
    const summaryParts = [];
    if (pacSubtypes) {
      if (pacSubtypes.cassette > 0) summaryParts.push(`PAC天カセ: ${pacSubtypes.cassette}台`);
      if (pacSubtypes.floor > 0) summaryParts.push(`PAC床置き: ${pacSubtypes.floor}台`);
      if (pacSubtypes.ceiling > 0) summaryParts.push(`PAC天吊り: ${pacSubtypes.ceiling}台`);
      if (pacSubtypes.wall > 0) summaryParts.push(`PAC壁掛け: ${pacSubtypes.wall}台`);
      if (pacSubtypes.other > 0) summaryParts.push(`PACその他: ${pacSubtypes.other}台`);
    } else if (pac > 0) {
      summaryParts.push(`PAC: ${pac}台`);
    }
    if (hex > 0) summaryParts.push(`全熱: ${hex}台`);
    if (fcu > 0) summaryParts.push(`FCU: ${fcu}台`);
    if (otherEquipment) summaryParts.push(otherEquipment);
    const equipSummary = summaryParts.length > 0 ? summaryParts.join(' / ') : '機器未登録';

    const fullPath = `TDR > ${park} > ${area} > ${facility} > ${floor} > ${room}`;
    const now = new Date().toISOString();

    const recordData = {
      id: this.editingId || 'rec_' + Date.now(),
      resort: 'TDR',
      park: park,
      area: area,
      facility: facility,
      floor: floor,
      room: room,
      fullPath: fullPath,
      // 空調機器の内訳
      pacCount: pac,
      pacSubtypes: { ...pacSubtypes },
      hexCount: hex,
      fcuCount: fcu,
      totalUnits: total,
      otherEquipment: otherEquipment,
      equipSummary: equipSummary,
      // 現場情報
      access: document.getElementById('access-input').value.trim(),
      equipment: document.getElementById('equipment-input').value.trim(),
      machineNo: document.getElementById('machine-no-input').value.trim(),
      filterSpec: document.getElementById('filter-spec-input').value.trim(),
      notes: document.getElementById('notes-input').value.trim(),
      photos: {
        entrance: [...this.currentPhotos.entrance],
        room: [...this.currentPhotos.room],
        equipment: [...this.currentPhotos.equipment]
      },
      updatedAt: now,
      createdAt: this.editingId ? (this.records.find(r => r.id === this.editingId)?.createdAt || now) : now
    };

    try {
      await this.saveRecord(recordData);
      this.showToast(this.editingId ? 'データを更新しました！' : 'リストに追加しました！');
      
      const wasEditing = !!this.editingId;
      this.resetForm();
      await this.loadRecords();
      this.updateParkAreas();

      if (wasEditing) {
        this.switchTab('tab-list');
      }
    } catch (err) {
      console.error(err);
      this.showToast('保存に失敗しました', true);
    }
  }

  resetForm() {
    this.editingId = null;
    this.currentPhotos = { entrance: [], room: [], equipment: [] };
    document.getElementById('edit-id').value = '';
    document.getElementById('edit-indicator').classList.add('hidden');
    document.getElementById('save-btn').textContent = '💾 この内容をリストに追加';

    const floorInput = document.getElementById('floor-input');
    if (floorInput) floorInput.value = '';
    document.getElementById('room-input').value = '';
    document.getElementById('access-input').value = '';
    document.getElementById('equipment-input').value = '';
    
    // ステッパーリセット (PAC各形式・全熱・FCU)
    ['pac-cassette-count', 'pac-floor-count', 'pac-ceiling-count', 'pac-wall-count', 'pac-other-count', 'hex-count', 'fcu-count'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '0';
    });
    document.getElementById('other-equip-input').value = '';
    this.updateTotalUnits();

    document.getElementById('area-manual').value = '';
    document.getElementById('facility-manual').value = '';
    document.getElementById('machine-no-input').value = '';
    document.getElementById('filter-spec-input').value = '';
    document.getElementById('notes-input').value = '';

    this.updateParkAreas();
    this.renderAllPhotoSlots();
    this.updatePathPreview();
  }

  // 編集モード
  editRecord(id) {
    const rec = this.records.find(r => r.id === id);
    if (!rec) return;

    this.editingId = rec.id;
    document.getElementById('edit-id').value = rec.id;
    document.getElementById('edit-indicator').classList.remove('hidden');
    document.getElementById('save-btn').textContent = '💾 変更を上書き保存';

    this.selectedPark = rec.park;
    document.querySelectorAll('.park-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.park === rec.park);
    });
    this.updateParkAreas();

    const areaSelect = document.getElementById('area-select');
    const matchedArea = Array.from(areaSelect.options).find(o => o.value === rec.area);
    if (matchedArea) {
      this.setManualArea(false);
      areaSelect.value = rec.area;
    } else {
      this.setManualArea(true);
      document.getElementById('area-manual').value = rec.area;
    }
    this.updateAreaFacilities();

    const facSelect = document.getElementById('facility-select');
    const matchedOpt = Array.from(facSelect.options).find(o => o.value === rec.facility);
    if (matchedOpt) {
      this.setManualFacility(false);
      facSelect.value = rec.facility;
    } else {
      this.setManualFacility(true);
      document.getElementById('facility-manual').value = rec.facility;
    }

    const floorInput = document.getElementById('floor-input');
    if (floorInput) floorInput.value = rec.floor || '';
    document.getElementById('room-input').value = rec.room;
    document.getElementById('access-input').value = rec.access || '';
    document.getElementById('equipment-input').value = rec.equipment || '';

    // 空調機台数セット (PAC形式別・全熱・FCU)
    const subs = rec.pacSubtypes || {};
    document.getElementById('pac-cassette-count').value = subs.cassette || 0;
    document.getElementById('pac-floor-count').value = subs.floor || 0;
    document.getElementById('pac-ceiling-count').value = subs.ceiling || 0;
    document.getElementById('pac-wall-count').value = subs.wall || 0;
    document.getElementById('pac-other-count').value = subs.other || (rec.pacCount && !subs.cassette && !subs.floor && !subs.ceiling && !subs.wall ? rec.pacCount : 0);
    document.getElementById('hex-count').value = rec.hexCount || 0;
    document.getElementById('fcu-count').value = rec.fcuCount || 0;
    document.getElementById('other-equip-input').value = rec.otherEquipment || '';
    this.updateTotalUnits();

    document.getElementById('machine-no-input').value = rec.machineNo || '';
    document.getElementById('filter-spec-input').value = rec.filterSpec || '';
    document.getElementById('notes-input').value = rec.notes || '';

    // 写真の復元
    const normalized = this.normalizePhotos(rec);
    this.currentPhotos = JSON.parse(JSON.stringify(normalized));
    this.renderAllPhotoSlots();
    this.updatePathPreview();
    this.renderAllChips();

    this.switchTab('tab-input');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // 複製（現場神機能）
  duplicateRecord(id) {
    const rec = this.records.find(r => r.id === id);
    if (!rec) return;

    this.resetForm();

    this.selectedPark = rec.park;
    document.querySelectorAll('.park-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.park === rec.park);
    });
    this.updateParkAreas();

    const areaSelect = document.getElementById('area-select');
    const matchedArea = Array.from(areaSelect.options).find(o => o.value === rec.area);
    if (matchedArea) {
      this.setManualArea(false);
      areaSelect.value = rec.area;
    } else {
      this.setManualArea(true);
      document.getElementById('area-manual').value = rec.area;
    }
    this.updateAreaFacilities();

    const facSelect = document.getElementById('facility-select');
    const matchedOpt = Array.from(facSelect.options).find(o => o.value === rec.facility);
    if (matchedOpt) {
      this.setManualFacility(false);
      facSelect.value = rec.facility;
    } else {
      this.setManualFacility(true);
      document.getElementById('facility-manual').value = rec.facility;
    }

    const floorInput = document.getElementById('floor-input');
    if (floorInput) floorInput.value = rec.floor || '';
    document.getElementById('room-input').value = rec.room + ' (複製)';
    document.getElementById('access-input').value = rec.access || '';
    document.getElementById('equipment-input').value = rec.equipment || '';

    // 空調機台数も引き継ぎ (PAC形式別・全熱・FCU)
    const subs = rec.pacSubtypes || {};
    document.getElementById('pac-cassette-count').value = subs.cassette || 0;
    document.getElementById('pac-floor-count').value = subs.floor || 0;
    document.getElementById('pac-ceiling-count').value = subs.ceiling || 0;
    document.getElementById('pac-wall-count').value = subs.wall || 0;
    document.getElementById('pac-other-count').value = subs.other || (rec.pacCount && !subs.cassette && !subs.floor && !subs.ceiling && !subs.wall ? rec.pacCount : 0);
    document.getElementById('hex-count').value = rec.hexCount || 0;
    document.getElementById('fcu-count').value = rec.fcuCount || 0;
    document.getElementById('other-equip-input').value = rec.otherEquipment || '';
    this.updateTotalUnits();

    document.getElementById('machine-no-input').value = rec.machineNo || '';
    document.getElementById('filter-spec-input').value = rec.filterSpec || '';
    document.getElementById('notes-input').value = rec.notes || '';

    // 入口写真は引き継ぐ
    const normalized = this.normalizePhotos(rec);
    this.currentPhotos = {
      entrance: [...(normalized.entrance || [])],
      room: [],
      equipment: []
    };

    this.renderAllPhotoSlots();
    this.updatePathPreview();
    this.renderAllChips();

    this.switchTab('tab-input');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    this.showToast('階層・機器台数・入口写真を引き継ぎました。新しい部屋名を入力してください');
  }

  async confirmDelete(id) {
    if (!confirm('この登録データを削除してもよろしいですか？')) return;
    try {
      await this.deleteRecord(id);
      this.showToast('データを削除しました');
      await this.loadRecords();
      this.updateParkAreas();
    } catch (err) {
      console.error(err);
      this.showToast('削除に失敗しました', true);
    }
  }

  // 写真構造の正規化
  normalizePhotos(rec) {
    if (!rec || !rec.photos) {
      return { entrance: [], room: [], equipment: [] };
    }
    if (!Array.isArray(rec.photos) && typeof rec.photos === 'object') {
      return {
        entrance: rec.photos.entrance || [],
        room: rec.photos.room || [],
        equipment: rec.photos.equipment || []
      };
    }
    const res = { entrance: [], room: [], equipment: [] };
    rec.photos.forEach((p, idx) => {
      if (idx === 0) res.entrance.push({ ...p, label: '建物入口', slot: 'entrance' });
      else if (idx === 1) res.room.push({ ...p, label: '部屋・室内', slot: 'room' });
      else res.equipment.push({ ...p, label: '対象機器', slot: 'equipment' });
    });
    return res;
  }

  // ================= 8. 一覧リストレンダリング =================
  renderRecordsList() {
    const container = document.getElementById('records-container');
    const emptyState = document.getElementById('empty-state');
    const countText = document.getElementById('filtered-count-text');

    const searchWord = (document.getElementById('list-search-input').value || '').trim().toLowerCase();
    const filterPark = document.getElementById('filter-park-select').value;
    const filterEquip = document.getElementById('filter-equipment-select').value;

    const filtered = this.records.filter(r => {
      if (filterPark && r.park !== filterPark) return false;
      if (filterEquip && !(r.equipment || '').includes(filterEquip)) return false;
      if (searchWord) {
        const targetStr = `${r.resort} ${r.park} ${r.area} ${r.facility} ${r.room} ${r.equipSummary || ''} ${r.access} ${r.equipment} ${r.machineNo} ${r.notes}`.toLowerCase();
        if (!targetStr.includes(searchWord)) return false;
      }
      return true;
    });

    countText.textContent = `全 ${this.records.length} 件中 ${filtered.length} 件表示`;

    if (this.records.length === 0) {
      container.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state"><h3>条件に一致するデータがありません</h3></div>';
      return;
    }

    container.innerHTML = filtered.map(r => {
      const parkClass = (r.park || '').toLowerCase();
      const pSlots = this.normalizePhotos(r);

      const allPhotos = [
        ...pSlots.entrance.map(p => ({ ...p, badge: '🚪 入口' })),
        ...pSlots.room.map(p => ({ ...p, badge: '🏢 部屋' })),
        ...pSlots.equipment.map(p => ({ ...p, badge: '⚙️ 機器' }))
      ];

      const photosHtml = allPhotos.length > 0 ? `
        <div class="card-photos-row">
          ${allPhotos.map(p => `
            <div class="card-thumb">
              <img src="${p.dataUrl}" alt="${p.label}" onclick="app.showModalPhoto('${p.dataUrl}', '${r.facility} - ${r.room} (${p.badge})')">
              <span class="photo-type-tag">${p.badge}</span>
            </div>
          `).join('')}
        </div>
      ` : '';

      // 空調機器バッジ群
      const pac = r.pacCount || 0;
      const subs = r.pacSubtypes || {};
      const hex = r.hexCount || 0;
      const fcu = r.fcuCount || 0;
      const total = r.totalUnits || (pac + hex + fcu);
      const other = r.otherEquipment || '';

      const unitBadges = [];
      if (total > 0) {
        unitBadges.push(`<span class="badge-unit badge-total-num">合計: ${total}台</span>`);
      }

      // PAC形式別バッジ
      let hasPacSub = false;
      if (subs.cassette > 0) { unitBadges.push(`<span class="badge-unit badge-pac-cas">❄️ 天カセ: ${subs.cassette}台</span>`); hasPacSub = true; }
      if (subs.floor > 0) { unitBadges.push(`<span class="badge-unit badge-pac-floor">❄️ 床置き: ${subs.floor}台</span>`); hasPacSub = true; }
      if (subs.ceiling > 0) { unitBadges.push(`<span class="badge-unit badge-pac-ceil">❄️ 天吊り: ${subs.ceiling}台</span>`); hasPacSub = true; }
      if (subs.wall > 0) { unitBadges.push(`<span class="badge-unit badge-pac-wall">❄️ 壁掛け: ${subs.wall}台</span>`); hasPacSub = true; }
      if (subs.other > 0) { unitBadges.push(`<span class="badge-unit badge-pac-other">❄️ 他PAC: ${subs.other}台</span>`); hasPacSub = true; }
      if (!hasPacSub && pac > 0) {
        unitBadges.push(`<span class="badge-unit badge-pac">❄️ PAC: ${pac}台</span>`);
      }

      if (hex > 0) unitBadges.push(`<span class="badge-unit badge-hex">🔄 全熱: ${hex}台</span>`);
      if (fcu > 0) unitBadges.push(`<span class="badge-unit badge-fcu">💨 FCU: ${fcu}台</span>`);
      if (other) unitBadges.push(`<span class="badge-unit badge-unit">${this.escapeHtml(other)}</span>`);

      const equipUnitsHtml = unitBadges.length > 0 ? `
        <div class="info-row">
          <span class="info-label">❄️ 空調機器:</span>
          <div class="info-value equip-badge-group">${unitBadges.join('')}</div>
        </div>
      ` : '';

      return `
        <div class="record-card">
          <div class="card-header-path">
            <div class="path-tag-row">
              <span class="park-tag ${parkClass}">${r.park}</span>
              <span class="area-tag">${this.escapeHtml(r.area)}</span>
            </div>
            <div class="facility-title">${this.escapeHtml(r.facility)}</div>
            <div class="room-highlight">📍 ${r.floor ? `${this.escapeHtml(r.floor)} / ` : ''}${this.escapeHtml(r.room)}</div>
          </div>

          <div class="info-block">
            ${equipUnitsHtml}
            ${r.equipment ? `<div class="info-row"><span class="info-label">🧰 必要なもの:</span><span class="info-value"><span class="badge-equipment">${this.escapeHtml(r.equipment)}</span></span></div>` : ''}
            ${r.access ? `<div class="info-row"><span class="info-label">🚪 アクセス:</span><span class="info-value">${this.escapeHtml(r.access)}</span></div>` : ''}
            ${(r.machineNo || r.filterSpec) ? `<div class="info-row"><span class="info-label">⚙️ 仕様/機番:</span><span class="info-value">${this.escapeHtml(r.filterSpec || '')} ${r.machineNo ? `(${this.escapeHtml(r.machineNo)})` : ''}</span></div>` : ''}
            ${r.notes ? `<div class="info-row"><span class="info-label">📝 備考:</span><span class="info-value text-muted">${this.escapeHtml(r.notes)}</span></div>` : ''}
          </div>

          ${photosHtml}

          <div class="card-actions">
            <button type="button" class="btn btn-sub btn-sm" onclick="app.duplicateRecord('${r.id}')">📑 複製</button>
            <button type="button" class="btn btn-sub btn-sm" onclick="app.editRecord('${r.id}')">✏️ 編集</button>
            <button type="button" class="btn btn-sub btn-sm" style="color:#ef4444;" onclick="app.confirmDelete('${r.id}')">🗑️ 削除</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // ================= 9. スプレッドシート連携（機器ごとに行分割出力） =================
  getExpandedRows() {
    const expanded = [];
    let no = 1;

    this.records.forEach(r => {
      const p = this.normalizePhotos(r);
      const pac = r.pacCount || 0;
      const hex = r.hexCount || 0;
      const fcu = r.fcuCount || 0;
      const other = (r.otherEquipment || '').trim();

      const items = [];
      const subs = r.pacSubtypes || {};
      const cCas = subs.cassette || 0;
      const cFloor = subs.floor || 0;
      const cCeil = subs.ceiling || 0;
      const cWall = subs.wall || 0;
      const cOth = subs.other || 0;

      let pacHandled = false;
      if (cCas > 0) { items.push({ type: 'パッケージ (天カセ)', count: `${cCas}台` }); pacHandled = true; }
      if (cFloor > 0) { items.push({ type: 'パッケージ (床置き)', count: `${cFloor}台` }); pacHandled = true; }
      if (cCeil > 0) { items.push({ type: 'パッケージ (天吊り)', count: `${cCeil}台` }); pacHandled = true; }
      if (cWall > 0) { items.push({ type: 'パッケージ (壁掛け)', count: `${cWall}台` }); pacHandled = true; }
      if (cOth > 0) { items.push({ type: 'パッケージ (その他)', count: `${cOth}台` }); pacHandled = true; }

      if (!pacHandled && pac > 0) {
        items.push({ type: 'パッケージ (PAC)', count: `${pac}台` });
      }

      if (hex > 0) items.push({ type: '全熱交換器 (HEX)', count: `${hex}台` });
      if (fcu > 0) items.push({ type: 'ファンコイル (FCU)', count: `${fcu}台` });
      if (other) items.push({ type: 'その他機器', count: other });

      if (items.length === 0) {
        items.push({ type: '空調機未登録', count: '-' });
      }

      items.forEach((item) => {
        expanded.push({
          no: no++,
          park: r.park,
          area: r.area,
          facility: r.facility,
          floor: r.floor || '',
          room: r.room,
          equipType: item.type,
          equipCount: item.count,
          equipment: r.equipment || '',
          access: r.access || '',
          entrancePhotos: p.entrance,
          roomPhotos: p.room,
          equipPhotos: p.equipment,
          filterSpec: r.filterSpec || '',
          machineNo: r.machineNo || '',
          notes: r.notes || '',
          fullPath: r.fullPath,
          createdAt: r.createdAt
        });
      });
    });

    return expanded;
  }

  renderSpreadsheetPreview() {
    const tbody = document.getElementById('spreadsheet-preview-body');
    const countEl = document.getElementById('preview-row-count');
    const rows = this.getExpandedRows();
    countEl.textContent = rows.length;

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="18" style="text-align:center; padding:20px; color:#94a3b8;">データがありません</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((r) => {
      let typeStyle = 'color:#f8fafc; font-weight:bold;';
      if (r.equipType.includes('天カセ')) typeStyle = 'color:#38bdf8; font-weight:bold;';
      else if (r.equipType.includes('床置き')) typeStyle = 'color:#22d3ee; font-weight:bold;';
      else if (r.equipType.includes('天吊り')) typeStyle = 'color:#818cf8; font-weight:bold;';
      else if (r.equipType.includes('壁掛け')) typeStyle = 'color:#60a5fa; font-weight:bold;';
      else if (r.equipType.includes('PAC') || r.equipType.includes('パッケージ')) typeStyle = 'color:#38bdf8; font-weight:bold;';
      else if (r.equipType.includes('全熱')) typeStyle = 'color:#34d399; font-weight:bold;';
      else if (r.equipType.includes('FCU')) typeStyle = 'color:#c084fc; font-weight:bold;';

      return `
        <tr>
          <td>${r.no}</td>
          <td><strong>${r.park}</strong></td>
          <td>${this.escapeHtml(r.area)}</td>
          <td><strong>${this.escapeHtml(r.facility)}</strong></td>
          <td style="text-align:center;">${this.escapeHtml(r.floor || '-')}</td>
          <td><strong style="color:#f1f5f9;">${this.escapeHtml(r.room)}</strong></td>
          <td><span style="${typeStyle}">● ${this.escapeHtml(r.equipType)}</span></td>
          <td style="text-align:center; font-weight:bold; color:#fbbf24;">${this.escapeHtml(r.equipCount)}</td>
          <td><strong style="color:#f59e0b;">${this.escapeHtml(r.equipment || '-')}</strong></td>
          <td>${this.escapeHtml(r.access || '-')}</td>
          <td>${r.entrancePhotos.length > 0 ? `あり(${r.entrancePhotos.length}枚)` : 'なし'}</td>
          <td>${r.roomPhotos.length > 0 ? `あり(${r.roomPhotos.length}枚)` : 'なし'}</td>
          <td>${r.equipPhotos.length > 0 ? `あり(${r.equipPhotos.length}枚)` : 'なし'}</td>
          <td>${this.escapeHtml(r.filterSpec || '-')}</td>
          <td>${this.escapeHtml(r.machineNo || '-')}</td>
          <td>${this.escapeHtml(r.notes || '')}</td>
          <td class="text-xs text-muted">${this.escapeHtml(r.fullPath)}</td>
          <td class="text-xs text-muted">${new Date(r.createdAt).toLocaleString('ja-JP')}</td>
        </tr>
      `;
    }).join('');
  }

  // クリップボードTSVコピー（行分割）
  async copyToClipboardTSV() {
    const rows = this.getExpandedRows();
    if (rows.length === 0) {
      this.showToast('コピーするデータがありません', true);
      return;
    }

    const headers = [
      'No', 'パーク', 'エリア', '施設/アトラクション', '階層', '部屋名',
      '空調機種別', '台数',
      '作業に必要なもの', 'アクセス方法',
      '建物入口写真', '部屋写真', '機器写真',
      'フィルター仕様', '機番・系統', '特記事項', '階層フルパス', '登録日時'
    ];

    const dataRows = rows.map((r) => [
      r.no,
      r.park,
      r.area,
      r.facility,
      r.floor || '',
      r.room,
      r.equipType,
      r.equipCount,
      (r.equipment || '').replace(/[\r\n]+/g, ' '),
      (r.access || '').replace(/[\r\n]+/g, ' '),
      r.entrancePhotos.length > 0 ? `あり(${r.entrancePhotos.length}枚)` : 'なし',
      r.roomPhotos.length > 0 ? `あり(${r.roomPhotos.length}枚)` : 'なし',
      r.equipPhotos.length > 0 ? `あり(${r.equipPhotos.length}枚)` : 'なし',
      r.filterSpec || '',
      r.machineNo || '',
      (r.notes || '').replace(/[\r\n]+/g, ' '),
      r.fullPath,
      new Date(r.createdAt).toLocaleString('ja-JP')
    ]);

    const tsvContent = [headers.join('\t'), ...dataRows.map(r => r.join('\t'))].join('\n');

    try {
      await navigator.clipboard.writeText(tsvContent);
      this.showToast('📋 空調機種別ごとに行を分けてクリップボードにコピーしました！');
    } catch (err) {
      this.fallbackCopyText(tsvContent);
    }
  }

  fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      this.showToast('📋 クリップボードにコピーしました！');
    } catch (e) {
      this.showToast('コピーに失敗しました', true);
    }
    document.body.removeChild(ta);
  }

  // CSVダウンロード（行分割）
  downloadCSV() {
    const rows = this.getExpandedRows();
    if (rows.length === 0) {
      this.showToast('ダウンロードするデータがありません', true);
      return;
    }

    const headers = [
      'No', 'パーク', 'エリア', '施設/アトラクション', '階層', '部屋名',
      '空調機種別', '台数',
      '作業に必要なもの', 'アクセス方法',
      '建物入口写真', '部屋写真', '機器写真',
      'フィルター仕様', '機番・系統', '特記事項', '階層フルパス', '登録日時'
    ];

    const escapeCsv = (str) => {
      const s = String(str || '');
      if (s.includes('"') || s.includes(',') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    const dataRows = rows.map((r) => [
      r.no,
      escapeCsv(r.park),
      escapeCsv(r.area),
      escapeCsv(r.facility),
      escapeCsv(r.floor),
      escapeCsv(r.room),
      escapeCsv(r.equipType),
      escapeCsv(r.equipCount),
      escapeCsv(r.equipment),
      escapeCsv(r.access),
      escapeCsv(r.entrancePhotos.length > 0 ? `あり(${r.entrancePhotos.length}枚)` : 'なし'),
      escapeCsv(r.roomPhotos.length > 0 ? `あり(${r.roomPhotos.length}枚)` : 'なし'),
      escapeCsv(r.equipPhotos.length > 0 ? `あり(${r.equipPhotos.length}枚)` : 'なし'),
      escapeCsv(r.filterSpec),
      escapeCsv(r.machineNo),
      escapeCsv(r.notes),
      escapeCsv(r.fullPath),
      escapeCsv(new Date(r.createdAt).toLocaleString('ja-JP'))
    ].join(','));

    const csvContent = '\uFEFF' + [headers.join(','), ...dataRows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `TDR_空調設備現場リスト_${this.getFormattedDate()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    this.showToast('📥 CSVファイルを保存しました');
  }

  // Excelダウンロード（行分割）
  downloadXLSX() {
    const rows = this.getExpandedRows();
    if (rows.length === 0) {
      this.showToast('ダウンロードするデータがありません', true);
      return;
    }

    if (typeof XLSX === 'undefined') {
      this.showToast('Excelライブラリが利用できないため、CSVをダウンロードします');
      this.downloadCSV();
      return;
    }

    const headers = [
      'No', 'パーク', 'エリア', '施設/アトラクション', '階層', '部屋名',
      '空調機種別', '台数',
      '作業に必要なもの', 'アクセス方法',
      '建物入口写真', '部屋写真', '機器写真',
      'フィルター仕様', '機番・系統', '特記事項', '階層フルパス', '登録日時'
    ];

    const data = [
      headers,
      ...rows.map((r) => [
        r.no,
        r.park,
        r.area,
        r.facility,
        r.floor || '',
        r.room,
        r.equipType,
        r.equipCount,
        r.equipment || '',
        r.access || '',
        r.entrancePhotos.length > 0 ? `あり(${r.entrancePhotos.length}枚)` : 'なし',
        r.roomPhotos.length > 0 ? `あり(${r.roomPhotos.length}枚)` : 'なし',
        r.equipPhotos.length > 0 ? `あり(${r.equipPhotos.length}枚)` : 'なし',
        r.filterSpec || '',
        r.machineNo || '',
        r.notes || '',
        r.fullPath,
        new Date(r.createdAt).toLocaleString('ja-JP')
      ])
    ];

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [
      { wch: 6 },  // No
      { wch: 10 }, // パーク
      { wch: 22 }, // エリア
      { wch: 26 }, // 施設
      { wch: 10 }, // 階層
      { wch: 20 }, // 部屋名
      { wch: 20 }, // 空調機種別
      { wch: 10 }, // 台数
      { wch: 32 }, // 作業に必要なもの
      { wch: 32 }, // アクセス方法
      { wch: 14 }, // 入口写真
      { wch: 14 }, // 部屋写真
      { wch: 14 }, // 機器写真
      { wch: 22 }, // フィルター仕様
      { wch: 15 }, // 機番
      { wch: 25 }, // 特記事項
      { wch: 45 }, // フルパス
      { wch: 20 }  // 登録日時
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'TDR空調設備リスト');
    XLSX.writeFile(wb, `TDR_空調設備現場リスト_${this.getFormattedDate()}.xlsx`);
    this.showToast('📗 Excelファイルをダウンロードしました');
  }

  // JSONバックアップ & 復元
  exportJSON() {
    if (this.records.length === 0) {
      this.showToast('保存するデータがありません', true);
      return;
    }
    const jsonStr = JSON.stringify({
      records: this.records,
      candidates: this.candidates
    }, null, 2);

    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `TDR_HVAC_Backup_${this.getFormattedDate()}.json`;
    link.click();
    URL.revokeObjectURL(url);
    this.showToast('💾 バックアップJSONを保存しました');
  }

  async importJSON(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const imported = JSON.parse(event.target.result);
        const recordList = Array.isArray(imported) ? imported : (imported.records || []);

        if (imported.candidates) {
          this.candidates = imported.candidates;
          this.saveCandidates();
          this.renderAllChips();
        }

        for (const item of recordList) {
          if (item.id) await this.saveRecord(item);
        }

        this.showToast(`${recordList.length} 件のデータを復元しました！`);
        await this.loadRecords();
        this.updateParkAreas();
      } catch (err) {
        console.error(err);
        this.showToast('JSONファイルの読み込みに失敗しました', true);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // ================= 10. 写真付き現場カルテ（印刷・PDF） =================
  renderReportCards() {
    const container = document.getElementById('report-cards-container');
    if (this.records.length === 0) {
      container.innerHTML = '<div class="empty-state"><h3>データがありません</h3></div>';
      return;
    }

    container.innerHTML = this.records.map(r => {
      const p = this.normalizePhotos(r);
      const pac = r.pacCount || 0;
      const hex = r.hexCount || 0;
      const fcu = r.fcuCount || 0;
      const total = r.totalUnits || (pac + hex + fcu);
      const summary = r.equipSummary || (total > 0 ? `PAC: ${pac}台 / 全熱: ${hex}台 / FCU: ${fcu}台` : '未登録');

      const renderSlotHtml = (title, photos) => {
        if (!photos || photos.length === 0) {
          return `<div class="report-photo-box empty-slot"><div class="report-photo-label">${title}: 未撮影</div></div>`;
        }
        return photos.map(photo => `
          <div class="report-photo-box">
            <img src="${photo.dataUrl}" alt="${photo.label}">
            <div class="report-photo-label">${title}</div>
          </div>
        `).join('');
      };

      const floorText = r.floor ? ` ＞ ${this.escapeHtml(r.floor)}` : '';

      return `
        <div class="report-card">
          <div class="report-header">
            <div class="report-path">🏰 ${r.resort} ＞ ${r.park} ＞ ${this.escapeHtml(r.area)} ＞ ${this.escapeHtml(r.facility)}${floorText}</div>
            <div class="report-title">📍 ${this.escapeHtml(r.room)}</div>
          </div>

          <table class="report-info-table">
            <tr>
              <th>🏢 階層</th>
              <td><strong>${this.escapeHtml(r.floor || '未記入')}</strong></td>
            </tr>
            <tr>
              <th>❄️ 空調機器 内訳</th>
              <td><strong style="color:#0284c7; font-size:14px;">${this.escapeHtml(summary)}</strong>（合計: <strong>${total}台</strong>）</td>
            </tr>
            <tr>
              <th>🧰 作業に必要なもの</th>
              <td><span style="color:#b45309; font-weight:bold;">${this.escapeHtml(r.equipment || '未記入')}</span></td>
            </tr>
            <tr>
              <th>🚪 アクセス方法</th>
              <td><strong>${this.escapeHtml(r.access || '未記入')}</strong></td>
            </tr>
            <tr>
              <th>⚙️ フィルター仕様</th>
              <td>${this.escapeHtml(r.filterSpec || '-')} ${r.machineNo ? `(機番: ${this.escapeHtml(r.machineNo)})` : ''}</td>
            </tr>
            ${r.notes ? `<tr><th>📝 特記事項・安全注意</th><td>${this.escapeHtml(r.notes)}</td></tr>` : ''}
          </table>

          <div class="report-photos-grid mt-2">
            ${renderSlotHtml('🚪 建物入口', p.entrance)}
            ${renderSlotHtml('🏢 部屋・室内', p.room)}
            ${renderSlotHtml('⚙️ 対象機器', p.equipment)}
          </div>
        </div>
      `;
    }).join('');
  }

  // ================= ユーティリティ =================
  switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-pane').forEach(p => {
      p.classList.toggle('active', p.id === tabId);
    });

    if (tabId === 'tab-list') {
      this.renderRecordsList();
    } else if (tabId === 'tab-export') {
      this.renderSpreadsheetPreview();
    } else if (tabId === 'tab-report') {
      this.renderReportCards();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  updateHeaderBadge() {
    const badge = document.getElementById('data-count-badge');
    if (badge) badge.textContent = `登録: ${this.records.length}件`;
  }

  showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.style.backgroundColor = isError ? 'rgba(239, 68, 68, 0.95)' : 'rgba(16, 185, 129, 0.95)';
    toast.classList.remove('hidden');

    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 2800);
  }

  getFormattedDate() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new HVACApp();
  app.init();
});
