// ==========================================================================
// TDR空調設備 現場リスト管理ツール - アプリケーションロジック
// ==========================================================================

const APP_DB_NAME = 'TDR_HVAC_FieldDB';
const APP_DB_VERSION = 1;
const STORE_NAME = 'records';
const CANDIDATES_STORAGE_KEY = 'TDR_HVAC_UserCaptions_v2';
const DRAFT_RECORD_ID = '__DRAFT_CURRENT__';
const DRAFT_LOCAL_KEY = 'TDR_HVAC_DraftBackup_v1';

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

    // 一覧タブの表示モード（まとめ方）と出力タブのシートモード
    this.listViewMode = 'card';         // 'card' | 'tree' | 'equip' | 'gear' | 'spec' | 'table'
    this.exportSheetMode = 'expanded';  // 'expanded' | 'room_summary' | 'facility_summary' | 'equip_summary'
    this.isRestoringDraft = false;
    this.draftTimer = null;

    // 候補チップの編集モード状態
    this.chipEditState = {
      area: false,
      facility: false,
      floor: false,
      room: false,
      access: false,
      equipment: false
    };

    // 作業チェックリストの状態
    this.checkStatusFilter = 'all'; // 'all' | 'pending' | 'completed'
    this.checkMultiFilters = {
      park: [],
      area: [],
      facility: [],
      floor: [],
      unitType: [],
      equipment: []
    };
    this.activeMultiFilterKey = null;
    this.tempMultiFilterSelected = [];

    // ユーザー自身が管理するキャプションデータ（初期デフォルトは全てなし・空配列）
    this.candidates = this.loadCandidates();
  }

  // 初期化
  async init() {
    await this.requestPersistentStorage();
    await this.initDB();
    this.setupUI();
    this.bindEvents();
    await this.loadRecords();
    this.updateParkAreas();
    this.updateTotalUnits();
    await this.restoreDraftIfPresent();
  }

  // OSによるストレージ自動削除（キャッシュクリア）を防止する永続化リクエスト
  async requestPersistentStorage() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        await navigator.storage.persist();
      }
    } catch (e) {
      console.warn('Persistent storage request warning:', e);
    }
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

    // 候補を追加した際、対応する入力欄にも即座に反映する
    const inputMap = {
      area: 'area-input',
      facility: 'facility-input',
      floor: 'floor-input',
      room: 'room-input',
      access: 'access-input',
      equipment: 'equipment-input'
    };
    const targetEl = document.getElementById(inputMap[type]);
    if (targetEl) {
      if (type === 'access' || type === 'equipment') {
        const cur = targetEl.value.trim();
        if (!cur) targetEl.value = trimmed;
        else if (!cur.includes(trimmed)) targetEl.value = `${cur} ${trimmed}`;
      } else {
        targetEl.value = trimmed;
      }
    }

    this.saveCandidates();
    this.updateParkAreas();
    this.updateAreaFacilities();
    this.updatePathPreview();
    this.renderAllChips();
    this.scheduleSaveDraft();

    this.showToast(`「${trimmed}」を候補に追加し、入力欄に反映しました`);
  }

  removeCandidate(type, val) {
    if (!Array.isArray(this.candidates[type])) return;

    this.candidates[type] = this.candidates[type].filter(item => item !== val);
    this.saveCandidates();
    this.updateParkAreas();
    this.updateAreaFacilities();
    this.renderAllChips();

    this.showToast(`候補「${val}」を削除しました`);
  }

  renderAllChips() {
    this.renderChipsForType('area', 'area-chips', 'area-input');
    this.renderChipsForType('facility', 'facility-chips', 'facility-input');
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
    const currentInputVal = (document.getElementById(targetInputId)?.value || '').trim();

    if (list.length === 0) {
      container.innerHTML = '<span class="text-xs text-muted">登録済みの候補はありません（＋追加ボタンから登録できます）</span>';
      return;
    }

    container.innerHTML = list.map(item => {
      const deleteBtnHtml = isEditing ? `<button type="button" class="chip-delete-btn" data-type="${type}" data-val="${this.escapeHtml(item)}">✕</button>` : '';
      const isSelected = (type === 'access' || type === 'equipment')
        ? currentInputVal.includes(item)
        : (currentInputVal === item && item !== '');
      const activeClass = isSelected ? 'active-chip' : '';

      return `
        <button type="button" class="chip ${activeClass}" data-target="${targetInputId}" data-val="${this.escapeHtml(item)}">
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
    const cDuct = parseInt(document.getElementById('pac-duct-count')?.value || '0', 10) || 0;
    const cOther = parseInt(document.getElementById('pac-other-count')?.value || '0', 10) || 0;
    const cUnk = parseInt(document.getElementById('pac-unknown-count')?.value || '0', 10) || 0;

    const pacSubtypes = {
      cassette: cCas,
      floor: cFloor,
      ceiling: cCeil,
      wall: cWall,
      duct: cDuct,
      other: cOther,
      unknown: cUnk
    };

    const pacTotal = cCas + cFloor + cCeil + cWall + cDuct + cOther + cUnk;
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
        // 下書き専用レコード (__DRAFT_CURRENT__) は本登録リストから除外
        const allItems = request.result || [];
        this.records = allItems
          .filter(r => r && r.id !== DRAFT_RECORD_ID)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        try { this.updateHeaderBadge(); } catch (e) { console.error(e); }
        try { this.updateDynamicFilterOptions(); } catch (e) { console.error(e); }
        try { this.updateCheckFilterOptions(); } catch (e) { console.error(e); }
        try { this.renderRecordsList(); } catch (e) { console.error(e); }
        try { this.renderChecklistView(); } catch (e) { console.error(e); }
        try { this.renderSpreadsheetPreview(); } catch (e) { console.error(e); }
        try { this.renderReportCards(); } catch (e) { console.error(e); }
        try { this.updateAllDrumPickers(); } catch (e) { console.error(e); }
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

  // ================= 3.5. 入力途中データ（ドラフト＋撮影写真）のリアルタイム自動保存・復元 =================
  collectDraftState() {
    const { pac, pacSubtypes, hex, fcu, total } = this.updateTotalUnits();
    return {
      id: DRAFT_RECORD_ID,
      editingId: this.editingId || null,
      selectedPark: this.selectedPark || 'TDS',
      area: this.getCurrentAreaName(),
      facility: this.getCurrentFacilityName(),
      floor: document.getElementById('floor-input')?.value || '',
      room: document.getElementById('room-input')?.value || '',
      access: document.getElementById('access-input')?.value || '',
      equipment: document.getElementById('equipment-input')?.value || '',
      pacSubtypes: { ...pacSubtypes },
      pacCount: pac,
      hexCount: hex,
      fcuCount: fcu,
      totalUnits: total,
      otherEquipment: document.getElementById('other-equip-input')?.value || '',
      filterSpec: document.getElementById('filter-spec-input')?.value || '',
      machineNo: document.getElementById('machine-no-input')?.value || '',
      notes: document.getElementById('notes-input')?.value || '',
      photos: {
        entrance: [...(this.currentPhotos.entrance || [])],
        room: [...(this.currentPhotos.room || [])],
        equipment: [...(this.currentPhotos.equipment || [])]
      },
      savedAt: new Date().toISOString()
    };
  }

  isDraftMeaningful(draft) {
    if (!draft) return false;
    const hasText = [
      draft.area, draft.areaSelectVal, draft.areaManualVal,
      draft.facility, draft.facilitySelectVal, draft.facilityManualVal,
      draft.floor, draft.room, draft.access, draft.equipment,
      draft.otherEquipment, draft.filterSpec, draft.machineNo, draft.notes
    ].some(v => v && String(v).trim().length > 0 && v !== '__MANUAL__');

    const hasUnits = (draft.totalUnits || 0) > 0;
    const hasPhotos = (
      (draft.photos?.entrance?.length || 0) +
      (draft.photos?.room?.length || 0) +
      (draft.photos?.equipment?.length || 0)
    ) > 0;

    return hasText || hasUnits || hasPhotos;
  }

  scheduleSaveDraft() {
    if (this.isRestoringDraft) return;
    const dot = document.getElementById('draft-status-dot');
    if (dot) dot.classList.add('saving');

    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.saveDraftNow();
    }, 150);
  }

  async saveDraftNow() {
    if (this.isRestoringDraft || !this.db) return;
    try {
      const draft = this.collectDraftState();
      // localStorage にも軽量テキストメタデータを即時ミラー保存（タスク強制終了対策）
      try {
        const lightDraft = { ...draft, photos: undefined };
        localStorage.setItem(DRAFT_LOCAL_KEY, JSON.stringify(lightDraft));
      } catch (e) {}

      // IndexedDB には写真Base64を含む完全データを保存
      await this.saveRecord(draft);

      const dot = document.getElementById('draft-status-dot');
      if (dot) dot.classList.remove('saving');

      const statusText = document.getElementById('draft-status-text');
      if (statusText) {
        if (this.isDraftMeaningful(draft)) {
          const t = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          const photoCount = (draft.photos.entrance.length + draft.photos.room.length + draft.photos.equipment.length);
          const photoInfo = photoCount > 0 ? `・写真${photoCount}枚` : '';
          statusText.textContent = `💾 入力途中データを自動保存済み (${t}${photoInfo}) — タスクを切っても復元されます`;
        } else {
          statusText.textContent = '🛡️ 自動保存ON（オフライン・タスク終了時も入力途中の内容を保持）';
        }
      }
    } catch (e) {
      console.warn('Draft auto-save error:', e);
    }
  }

  async clearDraft() {
    clearTimeout(this.draftTimer);
    try {
      localStorage.removeItem(DRAFT_LOCAL_KEY);
    } catch (e) {}
    if (this.db) {
      try {
        await this.deleteRecord(DRAFT_RECORD_ID);
      } catch (e) {}
    }
    const statusText = document.getElementById('draft-status-text');
    if (statusText) {
      statusText.textContent = '🛡️ 自動保存ON（オフライン・タスク終了時も入力途中の内容を保持）';
    }
  }

  async restoreDraftIfPresent() {
    if (!this.db) return;
    try {
      const draft = await new Promise((resolve) => {
        const tx = this.db.transaction([STORE_NAME], 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(DRAFT_RECORD_ID);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });

      let targetDraft = draft;
      if (!targetDraft) {
        try {
          const localStr = localStorage.getItem(DRAFT_LOCAL_KEY);
          if (localStr) targetDraft = JSON.parse(localStr);
        } catch (e) {}
      }

      if (!targetDraft || !this.isDraftMeaningful(targetDraft)) {
        return;
      }

      this.isRestoringDraft = true;

      // 編集モード状態
      if (targetDraft.editingId && this.records.some(r => r.id === targetDraft.editingId)) {
        this.editingId = targetDraft.editingId;
        document.getElementById('edit-id').value = targetDraft.editingId;
        document.getElementById('edit-indicator')?.classList.remove('hidden');
        document.getElementById('save-btn').textContent = '💾 変更を上書き保存';
      }

      // パーク復元
      this.selectedPark = targetDraft.selectedPark || 'TDS';
      document.querySelectorAll('.park-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.park === this.selectedPark);
      });
      this.updateParkAreas();
      this.updateAreaFacilities();

      // テキスト項目復元 (エリア・施設・階層・部屋・アクセス・機材・仕様・機番・備考)
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val || '';
      };
      const restoredArea = targetDraft.area || targetDraft.areaManualVal || (targetDraft.areaSelectVal !== '__MANUAL__' ? targetDraft.areaSelectVal : '') || '';
      const restoredFacility = targetDraft.facility || targetDraft.facilityManualVal || (targetDraft.facilitySelectVal !== '__MANUAL__' ? targetDraft.facilitySelectVal : '') || '';
      setVal('area-input', restoredArea);
      setVal('facility-input', restoredFacility);
      setVal('floor-input', targetDraft.floor);
      setVal('room-input', targetDraft.room);
      setVal('access-input', targetDraft.access);
      setVal('equipment-input', targetDraft.equipment);
      setVal('other-equip-input', targetDraft.otherEquipment);
      setVal('filter-spec-input', targetDraft.filterSpec);
      setVal('machine-no-input', targetDraft.machineNo);
      setVal('notes-input', targetDraft.notes);

      // ステッパー台数復元
      const subs = targetDraft.pacSubtypes || {};
      setVal('pac-cassette-count', subs.cassette || 0);
      setVal('pac-floor-count', subs.floor || 0);
      setVal('pac-ceiling-count', subs.ceiling || 0);
      setVal('pac-wall-count', subs.wall || 0);
      setVal('pac-duct-count', subs.duct || 0);
      setVal('pac-other-count', subs.other || 0);
      setVal('pac-unknown-count', subs.unknown || 0);
      setVal('hex-count', targetDraft.hexCount || 0);
      setVal('fcu-count', targetDraft.fcuCount || 0);
      this.updateTotalUnits();

      // 写真復元
      if (targetDraft.photos) {
        this.currentPhotos = {
          entrance: Array.isArray(targetDraft.photos.entrance) ? targetDraft.photos.entrance : [],
          room: Array.isArray(targetDraft.photos.room) ? targetDraft.photos.room : [],
          equipment: Array.isArray(targetDraft.photos.equipment) ? targetDraft.photos.equipment : []
        };
      }
      this.renderAllPhotoSlots();
      this.updatePathPreview();
      this.renderAllChips();
      this.updateAllDrumPickers();

      this.isRestoringDraft = false;

      const statusText = document.getElementById('draft-status-text');
      if (statusText) {
        statusText.textContent = '🔄 前回入力途中だったデータを自動復元しました（続きから入力できます）';
      }
      this.showToast('🔄 前回入力途中だったデータを自動復元しました');
    } catch (e) {
      this.isRestoringDraft = false;
      console.warn('Restore draft error:', e);
    }
  }

  // ================= 4. UIイベント登録 =================
  setupUI() {
    this.renderAllChips();
    this.renderAllPhotoSlots();
    this.updateAllDrumPickers();
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
        this.scheduleSaveDraft();
      });
    });

    // エリア・施設・階層・部屋名の入力イベント（リアルタイムにパスプレビュー＆チップハイライト＆ドラムピッカー同期＆自動保存）
    ['area', 'facility', 'floor', 'room'].forEach(type => {
      const inputEl = document.getElementById(`${type}-input`);
      const pickerEl = document.getElementById(`${type}-drum-picker`);

      if (inputEl) {
        const syncToPicker = () => {
          this.updatePathPreview();
          this.renderAllChips();
          if (type === 'area') this.updateFacilityDrumPicker();
          if (type === 'facility') this.updateRoomDrumPicker();
          if (pickerEl) {
            const val = inputEl.value.trim();
            const optionExists = Array.from(pickerEl.options).some(opt => opt.value === val);
            pickerEl.value = optionExists ? val : '';
          }
          this.scheduleSaveDraft();
        };

        inputEl.addEventListener('input', syncToPicker);
        inputEl.addEventListener('change', syncToPicker);
      }

      // ドラムピッカーで選択した際、テキスト入力欄に即時反映
      if (pickerEl && inputEl) {
        pickerEl.addEventListener('change', () => {
          if (pickerEl.value) {
            inputEl.value = pickerEl.value;
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));

            // 施設を選んだ際、もしエリアが未入力なら過去の登録履歴からエリアを自動補完！
            if (type === 'facility') {
              const areaInput = document.getElementById('area-input');
              if (areaInput && !areaInput.value.trim()) {
                const foundRec = this.records.find(r => r.facility === pickerEl.value && r.area);
                if (foundRec && foundRec.area) {
                  areaInput.value = foundRec.area;
                  areaInput.dispatchEvent(new Event('input', { bubbles: true }));
                  areaInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
              }
            }
          }
        });
      }
    });

    // その他すべての入力欄での自動下書き保存＆チップ状態更新
    ['access-input', 'equipment-input', 'other-equip-input', 'filter-spec-input', 'machine-no-input', 'notes-input'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => {
          if (id === 'access-input' || id === 'equipment-input') {
            this.renderAllChips();
          }
          this.scheduleSaveDraft();
        });
      }
    });

    // 入力クリアボタン（下書き消去）
    document.getElementById('clear-draft-btn')?.addEventListener('click', async () => {
      const draft = this.collectDraftState();
      if (this.isDraftMeaningful(draft)) {
        if (!confirm('現在入力途中の内容（写真含む）をクリアしてよろしいですか？')) return;
      }
      await this.resetForm(true);
      this.showToast('🗑️ 入力中の内容をクリアしました');
    });

    // バックグラウンド移行・タスクキル・画面ロック直前の即時保存
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.saveDraftNow();
      }
    });
    window.addEventListener('pagehide', () => this.saveDraftNow());
    window.addEventListener('beforeunload', () => this.saveDraftNow());

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
        this.scheduleSaveDraft();
      });
    });

    // ステッパーインプット直接変更
    ['pac-cassette-count', 'pac-floor-count', 'pac-ceiling-count', 'pac-wall-count', 'pac-duct-count', 'pac-other-count', 'pac-unknown-count', 'hex-count', 'fcu-count'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => {
          this.updateTotalUnits();
          this.scheduleSaveDraft();
        });
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
        this.renderChipsForType(type, `${type}-chips`, `${type}-input`);
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

    // 候補モーダルでEnterキー押下時も保存可能にする
    document.getElementById('candidate-input-val')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('save-candidate-btn')?.click();
      }
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
      if (!input) return;

      if (targetId === 'area-input' || targetId === 'facility-input' || targetId === 'floor-input' || targetId === 'room-input') {
        input.value = val;
      } else {
        const cur = input.value.trim();
        if (cur.length === 0) {
          input.value = val;
        } else if (!cur.includes(val)) {
          input.value = `${cur} ${val}`;
        }
      }
      this.updatePathPreview();
      this.renderAllChips();
      this.scheduleSaveDraft();
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

    // 写真登録アコーディオン（折りたたみ・展開）
    const togglePhotoBtn = document.getElementById('toggle-photo-section-btn');
    if (togglePhotoBtn) {
      togglePhotoBtn.addEventListener('click', () => this.togglePhotoSection());
      togglePhotoBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.togglePhotoSection();
        }
      });
    }

    // フォーム保存
    document.getElementById('record-form').addEventListener('submit', (e) => this.handleFormSubmit(e));
    document.getElementById('cancel-edit-btn').addEventListener('click', () => this.resetForm(true));

    // 一覧タブ: まとめ方（ビューモード）切替
    document.querySelectorAll('#list-view-modes .view-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#list-view-modes .view-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.listViewMode = btn.dataset.view || 'card';
        this.renderRecordsList();
      });
    });

    // 一覧タブからシート出力へジャンプ（まとめ方も連動）
    document.getElementById('go-to-export-with-view-btn')?.addEventListener('click', () => {
      const viewToExportMap = {
        card: 'expanded',
        table: 'expanded',
        tree: 'facility_summary',
        equip: 'equip_summary',
        spec: 'equip_summary',
        gear: 'room_summary'
      };
      this.exportSheetMode = viewToExportMap[this.listViewMode] || 'expanded';
      document.querySelectorAll('#export-mode-tabs .view-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.exportMode === this.exportSheetMode);
      });
      this.switchTab('tab-export');
    });

    // リスト検索・各種フィルター・ソート
    document.getElementById('list-search-input').addEventListener('input', (e) => {
      document.getElementById('clear-search-btn')?.classList.toggle('hidden', !e.target.value);
      this.renderRecordsList();
      this.renderSpreadsheetPreview();
    });
    document.getElementById('clear-search-btn').addEventListener('click', () => {
      document.getElementById('list-search-input').value = '';
      document.getElementById('clear-search-btn')?.classList.add('hidden');
      this.renderRecordsList();
      this.renderSpreadsheetPreview();
    });

    [
      'filter-park-select',
      'filter-area-select',
      'filter-facility-select',
      'filter-floor-select',
      'filter-unit-type-select',
      'filter-equipment-select',
      'filter-photo-select',
      'filter-work-status-select',
      'sort-order-select'
    ].forEach(id => {
      document.getElementById(id)?.addEventListener('change', () => {
        this.renderRecordsList();
        this.renderSpreadsheetPreview();
      });
    });

    // フィルター＆ソート条件リセット
    document.getElementById('reset-filters-btn')?.addEventListener('click', () => {
      document.getElementById('list-search-input').value = '';
      document.getElementById('clear-search-btn')?.classList.add('hidden');
      [
        'filter-park-select',
        'filter-area-select',
        'filter-facility-select',
        'filter-floor-select',
        'filter-unit-type-select',
        'filter-equipment-select',
        'filter-photo-select',
        'filter-work-status-select'
      ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      const sortEl = document.getElementById('sort-order-select');
      if (sortEl) sortEl.value = 'hierarchy';
      this.renderRecordsList();
      this.renderSpreadsheetPreview();
      this.showToast('🔄 フィルタ・並べ替え条件をリセットしました');
    });

    document.getElementById('scroll-to-top-btn')?.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // ================= 作業チェックリスト イベント登録 =================
    // 作業ステータス切替タブ (すべて / 未着手 / 完了)
    document.querySelectorAll('#check-status-tabs .status-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#check-status-tabs .status-tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.checkStatusFilter = btn.dataset.status || 'all';
        this.renderChecklistView();
      });
    });

    // 作業チェック検索
    document.getElementById('check-search-input')?.addEventListener('input', (e) => {
      document.getElementById('check-clear-search-btn')?.classList.toggle('hidden', !e.target.value);
      this.renderChecklistView();
    });
    document.getElementById('check-clear-search-btn')?.addEventListener('click', () => {
      const input = document.getElementById('check-search-input');
      if (input) input.value = '';
      document.getElementById('check-clear-search-btn')?.classList.add('hidden');
      this.renderChecklistView();
    });

    // 作業チェック 並べ替え
    document.getElementById('check-sort-order')?.addEventListener('change', () => {
      this.renderChecklistView();
    });

    // 作業チェック フィルタ条件クリア (複数選択すべてリセット)
    document.getElementById('check-reset-filters-btn')?.addEventListener('click', () => {
      const input = document.getElementById('check-search-input');
      if (input) input.value = '';
      document.getElementById('check-clear-search-btn')?.classList.add('hidden');
      this.checkMultiFilters = {
        park: [], area: [], facility: [], floor: [], unitType: [], equipment: []
      };
      const sortEl = document.getElementById('check-sort-order');
      if (sortEl) sortEl.value = 'hierarchy';
      this.renderCheckFilterButtonsAndChips();
      this.renderChecklistView();
      this.showToast('🔄 作業チェックの絞り込み条件をリセットしました');
    });

    // 複数選択絞り込みモーダルイベント
    document.getElementById('close-multi-filter-btn')?.addEventListener('click', () => this.closeCheckMultiFilter());
    document.getElementById('check-multi-filter-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'check-multi-filter-modal') this.closeCheckMultiFilter();
    });
    document.getElementById('multi-filter-search-input')?.addEventListener('input', (e) => {
      document.getElementById('multi-filter-search-clear')?.classList.toggle('hidden', !e.target.value);
      this.renderMultiFilterOptions();
    });
    document.getElementById('multi-filter-search-clear')?.addEventListener('click', () => {
      const inp = document.getElementById('multi-filter-search-input');
      if (inp) inp.value = '';
      document.getElementById('multi-filter-search-clear')?.classList.add('hidden');
      this.renderMultiFilterOptions();
    });
    document.getElementById('multi-filter-select-all-btn')?.addEventListener('click', () => {
      this.selectAllMultiFilterOptions(true);
    });
    document.getElementById('multi-filter-clear-all-btn')?.addEventListener('click', () => {
      this.selectAllMultiFilterOptions(false);
    });
    document.getElementById('apply-multi-filter-btn')?.addEventListener('click', () => {
      this.applyCheckMultiFilter();
    });

    document.getElementById('check-scroll-top-btn')?.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // 一括操作ボタン
    document.getElementById('check-batch-complete-btn')?.addEventListener('click', () => {
      this.batchSetChecklistComplete(true);
    });
    document.getElementById('check-batch-reset-btn')?.addEventListener('click', () => {
      this.batchSetChecklistComplete(false);
    });

    // 作業チェック画面からの印刷・シート出力連携
    document.getElementById('check-open-print-btn')?.addEventListener('click', () => {
      this.openChecklistPrintPreview('checklist');
    });
    document.getElementById('check-goto-sheet-btn')?.addEventListener('click', () => {
      const srcSel = document.getElementById('export-filter-source');
      if (srcSel) srcSel.value = 'checklist';
      this.exportSheetMode = 'checklist_print';
      document.querySelectorAll('#export-mode-tabs .view-mode-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.exportMode === 'checklist_print');
      });
      this.switchTab('tab-export');
      this.renderSpreadsheetPreview();
    });

    // シート出力タブ: まとめ方（5種類のシート形式）切替
    document.querySelectorAll('#export-mode-tabs .view-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#export-mode-tabs .view-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.exportSheetMode = btn.dataset.exportMode || 'expanded';
        this.renderSpreadsheetPreview();
      });
    });

    document.getElementById('export-filter-source')?.addEventListener('change', () => {
      this.renderSpreadsheetPreview();
    });
    document.getElementById('export-check-mark-mode')?.addEventListener('change', () => {
      this.renderSpreadsheetPreview();
    });

    // スプレッドシート出力・チェック表印刷
    document.getElementById('export-print-checklist-btn')?.addEventListener('click', () => {
      const src = document.getElementById('export-filter-source')?.value || 'list';
      const chkMode = document.getElementById('export-check-mark-mode')?.value || 'blank';
      this.openChecklistPrintPreview(src, chkMode);
    });
    document.getElementById('copy-tsv-btn').addEventListener('click', () => this.copyToClipboardTSV());
    document.getElementById('download-csv-btn').addEventListener('click', () => this.downloadCSV());
    document.getElementById('download-xlsx-btn').addEventListener('click', () => this.downloadXLSX());
    document.getElementById('export-json-btn').addEventListener('click', () => this.exportJSON());
    document.getElementById('import-json-input').addEventListener('change', (e) => this.importJSON(e));

    // 外部CSVインポートモーダルイベント
    document.getElementById('open-csv-import-btn')?.addEventListener('click', () => this.openCSVImportModal());
    document.getElementById('close-csv-import-btn')?.addEventListener('click', () => this.closeCSVImportModal());
    document.getElementById('cancel-csv-import-btn')?.addEventListener('click', () => this.closeCSVImportModal());
    document.getElementById('csv-import-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'csv-import-modal') this.closeCSVImportModal();
    });
    document.getElementById('csv-import-file-input')?.addEventListener('change', (e) => this.handleCSVImportFile(e));
    document.getElementById('csv-import-preview-btn')?.addEventListener('click', () => this.previewExternalCSVImport());
    document.getElementById('csv-import-park')?.addEventListener('change', () => {
      if (document.getElementById('csv-import-textarea')?.value.trim()) this.previewExternalCSVImport();
    });
    document.getElementById('csv-import-tag')?.addEventListener('input', () => {
      if (document.getElementById('csv-import-textarea')?.value.trim()) this.previewExternalCSVImport();
    });
    document.getElementById('csv-import-skip-dup')?.addEventListener('change', () => {
      if (document.getElementById('csv-import-textarea')?.value.trim()) this.previewExternalCSVImport();
    });
    document.getElementById('csv-import-exec-btn')?.addEventListener('click', () => this.executeExternalCSVImport());

    // A4縦 作業チェック表 印刷プレビューモーダル操作
    document.getElementById('close-print-modal-btn')?.addEventListener('click', () => this.closeChecklistPrintPreview());
    document.getElementById('cancel-print-modal-btn')?.addEventListener('click', () => this.closeChecklistPrintPreview());
    document.getElementById('checklist-print-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'checklist-print-modal') this.closeChecklistPrintPreview();
    });
    document.getElementById('print-modal-source-select')?.addEventListener('change', () => this.renderChecklistPrintPreview());
    document.getElementById('print-modal-check-select')?.addEventListener('change', () => this.renderChecklistPrintPreview());
    document.getElementById('exec-checklist-print-btn')?.addEventListener('click', () => this.executeChecklistPrint());

    // 写真付きカルテ印刷（通常印刷モードを保証）
    document.getElementById('print-report-btn').addEventListener('click', () => {
      document.body.classList.remove('printing-checklist');
      window.print();
    });

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
    this.togglePhotoSection(true);
    await this.saveDraftNow();
    this.showToast('📸 写真を追加し、自動下書き保存しました');
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

  togglePhotoSection(forceOpen = null) {
    const body = document.getElementById('photo-accordion-body');
    const toggleText = document.getElementById('photo-toggle-text');
    const arrow = document.getElementById('photo-accordion-arrow');
    if (!body) return;

    const isCurrentlyCollapsed = body.classList.contains('collapsed');
    const willOpen = forceOpen !== null ? forceOpen : isCurrentlyCollapsed;

    if (willOpen) {
      body.classList.remove('collapsed');
      if (toggleText) toggleText.textContent = 'たたむ';
      if (arrow) arrow.textContent = '▲';
    } else {
      body.classList.add('collapsed');
      if (toggleText) toggleText.textContent = '開く';
      if (arrow) arrow.textContent = '▽';
    }
  }

  updatePhotoAccordionBadge() {
    const totalCount = (this.currentPhotos.entrance?.length || 0) +
                       (this.currentPhotos.room?.length || 0) +
                       (this.currentPhotos.equipment?.length || 0);

    const badge = document.getElementById('photo-total-badge');
    if (badge) {
      if (totalCount > 0) {
        badge.textContent = `📸 ${totalCount}枚登録中`;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
  }

  renderAllPhotoSlots() {
    this.renderSlotGrid('entrance', 'entrance-preview-grid');
    this.renderSlotGrid('room', 'room-preview-grid');
    this.renderSlotGrid('equipment', 'equipment-preview-grid');
    this.updatePhotoAccordionBadge();
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
      this.scheduleSaveDraft();
    }
  }

  showModalPhoto(dataUrl, caption) {
    const modal = document.getElementById('photo-modal');
    document.getElementById('modal-img').src = dataUrl;
    document.getElementById('modal-caption').textContent = caption || '';
    modal.classList.remove('hidden');
  }

  // ================= 6. エリア・施設入力 & 候補サジェスト連携 =================
  getCurrentAreaName() {
    return (document.getElementById('area-input')?.value || '').trim();
  }

  getCurrentFacilityName() {
    return (document.getElementById('facility-input')?.value || '').trim();
  }

  // 日本語の五十音順ソート（ひらがな・カタカナ・漢字・英数を五十音順に並べ替え）
  sortJapaneseGojuon(list) {
    return list.slice().sort((a, b) => {
      return (a || '').localeCompare(b || '', 'ja', { numeric: true, sensitivity: 'base' });
    });
  }

  // ドラムピッカー（セレクトボックス）の選択肢を登録済みデータ＆五十音順で動的更新
  updateAllDrumPickers() {
    this.updateAreaDrumPicker();
    this.updateFacilityDrumPicker();
    this.updateFloorDrumPicker();
    this.updateRoomDrumPicker();
  }

  updateAreaDrumPicker() {
    const picker = document.getElementById('area-drum-picker');
    if (!picker) return;

    const candidateAreas = this.candidates.area || [];
    const recordAreas = this.records
      .filter(r => !this.selectedPark || r.park === this.selectedPark)
      .map(r => r.area);
    const uniqueAreas = Array.from(new Set([...candidateAreas, ...recordAreas].filter(Boolean)));
    const sortedAreas = this.sortJapaneseGojuon(uniqueAreas);

    const currentVal = this.getCurrentAreaName();
    let optionsHtml = `<option value="">🎡 登録済エリアから選択 (五十音順: ${sortedAreas.length}件) ▼</option>`;
    optionsHtml += sortedAreas.map(a => {
      const isSel = (a === currentVal) ? 'selected' : '';
      return `<option value="${this.escapeHtml(a)}" ${isSel}>${this.escapeHtml(a)}</option>`;
    }).join('');

    picker.innerHTML = optionsHtml;
    picker.value = sortedAreas.includes(currentVal) ? currentVal : '';
  }

  updateFacilityDrumPicker() {
    const picker = document.getElementById('facility-drum-picker');
    if (!picker) return;

    const candidateFacs = this.candidates.facility || [];
    // 選択中パークの全登録施設 + 全候補施設（五十音順でいつでも探せる）
    const recordFacs = this.records
      .filter(r => !this.selectedPark || r.park === this.selectedPark)
      .map(r => r.facility);

    const uniqueFacs = Array.from(new Set([...candidateFacs, ...recordFacs].filter(Boolean)));
    const sortedFacs = this.sortJapaneseGojuon(uniqueFacs);

    const currentVal = this.getCurrentFacilityName();
    let optionsHtml = `<option value="">🏰 登録済施設から選択 (五十音順: ${sortedFacs.length}件) ▼</option>`;
    optionsHtml += sortedFacs.map(f => {
      const isSel = (f === currentVal) ? 'selected' : '';
      return `<option value="${this.escapeHtml(f)}" ${isSel}>${this.escapeHtml(f)}</option>`;
    }).join('');

    picker.innerHTML = optionsHtml;
    picker.value = sortedFacs.includes(currentVal) ? currentVal : '';
  }

  updateFloorDrumPicker() {
    const picker = document.getElementById('floor-drum-picker');
    if (!picker) return;

    const candidateFloors = this.candidates.floor || [];
    const recordFloors = this.records.map(r => r.floor).filter(Boolean);
    const uniqueFloors = Array.from(new Set([...candidateFloors, ...recordFloors]));
    const sortedFloors = this.sortJapaneseGojuon(uniqueFloors);

    const currentVal = (document.getElementById('floor-input')?.value || '').trim();
    let optionsHtml = `<option value="">🏢 登録済階層から選択 (${sortedFloors.length}件) ▼</option>`;
    optionsHtml += sortedFloors.map(fl => {
      const isSel = (fl === currentVal) ? 'selected' : '';
      return `<option value="${this.escapeHtml(fl)}" ${isSel}>${this.escapeHtml(fl)}</option>`;
    }).join('');

    picker.innerHTML = optionsHtml;
    picker.value = sortedFloors.includes(currentVal) ? currentVal : '';
  }

  updateRoomDrumPicker() {
    const picker = document.getElementById('room-drum-picker');
    if (!picker) return;

    const currentFacility = this.getCurrentFacilityName();
    const candidateRooms = this.candidates.room || [];
    let recordRooms = this.records
      .filter(r => !currentFacility || r.facility === currentFacility)
      .map(r => r.room)
      .filter(Boolean);

    if (recordRooms.length === 0) {
      recordRooms = this.records.map(r => r.room).filter(Boolean);
    }

    const uniqueRooms = Array.from(new Set([...candidateRooms, ...recordRooms]));
    const sortedRooms = this.sortJapaneseGojuon(uniqueRooms);

    const currentVal = (document.getElementById('room-input')?.value || '').trim();
    let optionsHtml = `<option value="">📍 登録済部屋名から選択 (五十音順: ${sortedRooms.length}件) ▼</option>`;
    optionsHtml += sortedRooms.map(rm => {
      const isSel = (rm === currentVal) ? 'selected' : '';
      return `<option value="${this.escapeHtml(rm)}" ${isSel}>${this.escapeHtml(rm)}</option>`;
    }).join('');

    picker.innerHTML = optionsHtml;
    picker.value = sortedRooms.includes(currentVal) ? currentVal : '';
  }

  updateParkAreas() {
    const datalist = document.getElementById('area-datalist');
    if (datalist) {
      const candidateAreas = this.candidates.area || [];
      const recordAreas = this.records.filter(r => r.park === this.selectedPark).map(r => r.area);
      const uniqueAreas = Array.from(new Set([...candidateAreas, ...recordAreas].filter(Boolean)));
      const sortedAreas = this.sortJapaneseGojuon(uniqueAreas);
      datalist.innerHTML = sortedAreas.map(a => `<option value="${this.escapeHtml(a)}"></option>`).join('');
    }
    this.updateAreaFacilities();
    this.updatePathPreview();
    this.renderAllChips();
    this.updateAllDrumPickers();
  }

  updateAreaFacilities() {
    const datalist = document.getElementById('facility-datalist');
    if (datalist) {
      const candidateFacs = this.candidates.facility || [];
      const recordFacs = this.records.filter(r => r.park === this.selectedPark).map(r => r.facility);
      const uniqueFacs = Array.from(new Set([...candidateFacs, ...recordFacs].filter(Boolean)));
      const sortedFacs = this.sortJapaneseGojuon(uniqueFacs);
      datalist.innerHTML = sortedFacs.map(f => `<option value="${this.escapeHtml(f)}"></option>`).join('');
    }
    this.updatePathPreview();
    this.renderAllChips();
    this.updateFacilityDrumPicker();
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
    const room = document.getElementById('room-input')?.value.trim() || '';

    if (!area) {
      this.showToast('エリア / テーマポートを入力（または候補から選択）してください', true);
      document.getElementById('area-input')?.focus();
      return;
    }

    if (!facility) {
      this.showToast('施設 / アトラクション名を入力（または候補から選択）してください', true);
      document.getElementById('facility-input')?.focus();
      return;
    }

    if (!floor) {
      this.showToast('階層（1Fなど）を入力してください', true);
      document.getElementById('floor-input')?.focus();
      return;
    }

    if (!room) {
      this.showToast('部屋名を入力してください', true);
      document.getElementById('room-input')?.focus();
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
      if (pacSubtypes.duct > 0) summaryParts.push(`PAC隠蔽ダクト: ${pacSubtypes.duct}台`);
      if (pacSubtypes.other > 0) summaryParts.push(`PACその他: ${pacSubtypes.other}台`);
      if (pacSubtypes.unknown > 0) summaryParts.push(`PAC(種別確認中): ${pacSubtypes.unknown}台`);
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
      const wasEditing = !!this.editingId;
      this.showToast(wasEditing ? 'データを更新しました！' : 'リストに追加しました！（場所・階層を引き継ぎます）');
      
      // 連続入力しやすいよう、登録後は「パーク・エリア・施設名・階層」を残し、部屋名・アクセス方法・台数・写真等をクリアする
      await this.resetForm(true, true);
      await this.loadRecords();
      this.updateParkAreas();

      if (wasEditing) {
        this.switchTab('tab-list');
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (err) {
      console.error(err);
      this.showToast('保存に失敗しました', true);
    }
  }

  async resetForm(alsoClearDraft = true, keepContinuousFields = false) {
    this.isRestoringDraft = true;
    this.editingId = null;
    this.currentPhotos = { entrance: [], room: [], equipment: [] };
    document.getElementById('edit-id').value = '';
    document.getElementById('edit-indicator').classList.add('hidden');
    document.getElementById('save-btn').textContent = '💾 この内容をリストに追加';

    document.querySelectorAll('.park-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.park === this.selectedPark);
    });

    // keepContinuousFields=true の場合は「エリア・施設名・階層」を残し、アクセス方法（オン/バックステージ等）も含めそれ以外をクリア
    const fieldsToClear = keepContinuousFields
      ? ['room-input', 'access-input', 'equipment-input', 'other-equip-input', 'machine-no-input', 'filter-spec-input', 'notes-input']
      : ['area-input', 'facility-input', 'floor-input', 'room-input', 'access-input', 'equipment-input', 'other-equip-input', 'machine-no-input', 'filter-spec-input', 'notes-input'];

    fieldsToClear.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    
    // ステッパーリセット (PAC各形式・全熱・FCU)
    ['pac-cassette-count', 'pac-floor-count', 'pac-ceiling-count', 'pac-wall-count', 'pac-duct-count', 'pac-other-count', 'pac-unknown-count', 'hex-count', 'fcu-count'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '0';
    });
    this.updateTotalUnits();

    this.updateParkAreas();
    this.renderAllPhotoSlots();
    this.togglePhotoSection(false);
    this.updatePathPreview();
    this.renderAllChips();
    this.updateAllDrumPickers();
    this.isRestoringDraft = false;

    if (keepContinuousFields) {
      // 引き継いだ「エリア・施設・階層」を下書きとしても保存しておく（タスクキルしても残るように）
      await this.saveDraftNow();
      const statusText = document.getElementById('draft-status-text');
      if (statusText) {
        statusText.textContent = '📍 前回の「エリア・施設名・階層」を引き継ぎ中（続けて次の部屋を入力できます）';
      }
    } else if (alsoClearDraft) {
      await this.clearDraft();
    }
  }

  // 編集モード
  editRecord(id) {
    const rec = this.records.find(r => r.id === id);
    if (!rec) return;

    this.isRestoringDraft = true;
    this.editingId = rec.id;
    document.getElementById('edit-id').value = rec.id;
    document.getElementById('edit-indicator').classList.remove('hidden');
    document.getElementById('save-btn').textContent = '💾 変更を上書き保存';

    this.selectedPark = rec.park || 'TDS';
    document.querySelectorAll('.park-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.park === this.selectedPark);
    });

    const setVal = (elId, v) => {
      const el = document.getElementById(elId);
      if (el) el.value = v || '';
    };
    setVal('area-input', rec.area);
    setVal('facility-input', rec.facility);
    setVal('floor-input', rec.floor);
    setVal('room-input', rec.room);
    setVal('access-input', rec.access);
    setVal('equipment-input', rec.equipment);

    // 空調機台数セット (PAC形式別・全熱・FCU)
    const subs = rec.pacSubtypes || {};
    document.getElementById('pac-cassette-count').value = subs.cassette || 0;
    document.getElementById('pac-floor-count').value = subs.floor || 0;
    document.getElementById('pac-ceiling-count').value = subs.ceiling || 0;
    document.getElementById('pac-wall-count').value = subs.wall || 0;
    document.getElementById('pac-duct-count').value = subs.duct || 0;
    document.getElementById('pac-other-count').value = subs.other || (rec.pacCount && !subs.cassette && !subs.floor && !subs.ceiling && !subs.wall && !subs.duct && !subs.unknown ? rec.pacCount : 0);
    document.getElementById('pac-unknown-count').value = subs.unknown || 0;
    document.getElementById('hex-count').value = rec.hexCount || 0;
    document.getElementById('fcu-count').value = rec.fcuCount || 0;
    setVal('other-equip-input', rec.otherEquipment);
    this.updateTotalUnits();

    setVal('machine-no-input', rec.machineNo);
    setVal('filter-spec-input', rec.filterSpec);
    setVal('notes-input', rec.notes);

    // 写真の復元
    const normalized = this.normalizePhotos(rec);
    this.currentPhotos = JSON.parse(JSON.stringify(normalized));
    this.updateParkAreas();
    this.renderAllPhotoSlots();
    this.togglePhotoSection(false);
    this.updatePathPreview();
    this.renderAllChips();
    this.updateAllDrumPickers();
    this.isRestoringDraft = false;
    this.scheduleSaveDraft();

    this.switchTab('tab-input');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // 複製（現場神機能）
  async duplicateRecord(id) {
    const rec = this.records.find(r => r.id === id);
    if (!rec) return;

    await this.resetForm(false);
    this.isRestoringDraft = true;

    this.selectedPark = rec.park || 'TDS';
    document.querySelectorAll('.park-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.park === this.selectedPark);
    });

    const setVal = (elId, v) => {
      const el = document.getElementById(elId);
      if (el) el.value = v || '';
    };
    setVal('area-input', rec.area);
    setVal('facility-input', rec.facility);
    setVal('floor-input', rec.floor);
    setVal('room-input', (rec.room || '') + ' (複製)');
    setVal('access-input', rec.access);
    setVal('equipment-input', rec.equipment);

    // 空調機台数も引き継ぎ (PAC形式別・全熱・FCU)
    const subs = rec.pacSubtypes || {};
    document.getElementById('pac-cassette-count').value = subs.cassette || 0;
    document.getElementById('pac-floor-count').value = subs.floor || 0;
    document.getElementById('pac-ceiling-count').value = subs.ceiling || 0;
    document.getElementById('pac-wall-count').value = subs.wall || 0;
    document.getElementById('pac-duct-count').value = subs.duct || 0;
    document.getElementById('pac-other-count').value = subs.other || (rec.pacCount && !subs.cassette && !subs.floor && !subs.ceiling && !subs.wall && !subs.duct && !subs.unknown ? rec.pacCount : 0);
    document.getElementById('pac-unknown-count').value = subs.unknown || 0;
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
    this.isRestoringDraft = false;
    this.scheduleSaveDraft();

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

  // ================= 8. 高度なフィルタ・並べ替え・6種のまとめ方（ビュー切替） =================
  // 階層名の自然順数値変換（B3F -> -3, B1F -> -1, 1F -> 1, 2F -> 2, M2F -> 2.5, R/屋上 -> 99）
  parseFloorOrder(floorStr) {
    const s = String(floorStr || '').trim().toUpperCase();
    if (!s) return 999;
    if (s.includes('屋上') || s === 'R' || s === 'RF' || s.includes('ROOF')) return 100;
    const bMatch = s.match(/B\s*(\d+)/) || s.match(/地下\s*(\d+)/);
    if (bMatch) return -parseInt(bMatch[1], 10);
    const mMatch = s.match(/M\s*(\d+)/) || s.match(/中\s*(\d+)/);
    if (mMatch) return parseInt(mMatch[1], 10) + 0.5;
    const fMatch = s.match(/(\d+)\s*F/) || s.match(/(\d+)\s*階/) || s.match(/^(\d+)$/);
    if (fMatch) return parseInt(fMatch[1], 10);
    return 50;
  }

  // 必要な脚立の最大尺数を抽出（ソート用）
  parseMaxLadder(equipStr) {
    const s = String(equipStr || '');
    const matches = [...s.matchAll(/(\d+)\s*尺/g)];
    if (matches.length === 0) return 0;
    return Math.max(...matches.map(m => parseInt(m[1], 10)));
  }

  // 登録データからエリア・施設・階層のフィルタ選択肢を動的生成
  updateDynamicFilterOptions() {
    const populateSelect = (selectId, defaultLabel, values, sortFn) => {
      const sel = document.getElementById(selectId);
      if (!sel) return;
      const prevVal = sel.value;
      const uniqueVals = Array.from(new Set(values.filter(v => v !== null && v !== undefined && String(v).trim().length > 0)));
      if (sortFn) uniqueVals.sort(sortFn);
      else uniqueVals.sort((a, b) => String(a).localeCompare(String(b), 'ja'));

      sel.innerHTML = `<option value="">${defaultLabel}</option>` +
        uniqueVals.map(v => `<option value="${this.escapeHtml(v)}">${this.escapeHtml(v)}</option>`).join('');
      if (prevVal && uniqueVals.includes(prevVal)) {
        sel.value = prevVal;
      }
    };

    populateSelect('filter-area-select', '🗺️ 全エリア', this.records.map(r => r.area));
    populateSelect('filter-facility-select', '🏢 全施設', this.records.map(r => r.facility));
    populateSelect(
      'filter-floor-select',
      '📶 全階層',
      this.records.map(r => r.floor),
      (a, b) => this.parseFloorOrder(a) - this.parseFloorOrder(b) || String(a).localeCompare(String(b), 'ja')
    );
  }

  // 現在のフィルタ条件が有効かどうか
  hasActiveFilters() {
    const searchWord = (document.getElementById('list-search-input')?.value || '').trim();
    const filterIds = [
      'filter-park-select',
      'filter-area-select',
      'filter-facility-select',
      'filter-floor-select',
      'filter-unit-type-select',
      'filter-equipment-select',
      'filter-photo-select',
      'filter-work-status-select'
    ];
    return !!searchWord || filterIds.some(id => !!(document.getElementById(id)?.value));
  }

  // フィルタ＆並べ替え適用済みレコード配列を取得
  getFilteredAndSortedRecords(ignoreFilter = false) {
    let list = [...this.records];

    if (!ignoreFilter) {
      const searchWord = (document.getElementById('list-search-input')?.value || '').trim().toLowerCase();
      const filterPark = document.getElementById('filter-park-select')?.value || '';
      const filterArea = document.getElementById('filter-area-select')?.value || '';
      const filterFacility = document.getElementById('filter-facility-select')?.value || '';
      const filterFloor = document.getElementById('filter-floor-select')?.value || '';
      const filterUnitType = document.getElementById('filter-unit-type-select')?.value || '';
      const filterEquip = document.getElementById('filter-equipment-select')?.value || '';
      const filterPhoto = document.getElementById('filter-photo-select')?.value || '';
      const filterWorkStatus = document.getElementById('filter-work-status-select')?.value || '';

      list = list.filter(r => {
        if (filterWorkStatus === 'pending' && r.completed) return false;
        if (filterWorkStatus === 'completed' && !r.completed) return false;

        if (filterPark && r.park !== filterPark) return false;
        if (filterArea && r.area !== filterArea) return false;
        if (filterFacility && r.facility !== filterFacility) return false;
        if (filterFloor && (r.floor || '') !== filterFloor) return false;

        if (filterUnitType) {
          const subs = r.pacSubtypes || {};
          const pac = r.pacCount || 0;
          const hex = r.hexCount || 0;
          const fcu = r.fcuCount || 0;
          const other = (r.otherEquipment || '').trim();
          if (filterUnitType === 'cassette' && !(subs.cassette > 0)) return false;
          if (filterUnitType === 'floor' && !(subs.floor > 0)) return false;
          if (filterUnitType === 'ceiling' && !(subs.ceiling > 0)) return false;
          if (filterUnitType === 'wall' && !(subs.wall > 0)) return false;
          if (filterUnitType === 'duct' && !(subs.duct > 0)) return false;
          if (filterUnitType === 'other_pac' && !(subs.other > 0)) return false;
          if (filterUnitType === 'unknown_pac' && !(subs.unknown > 0)) return false;
          if (filterUnitType === 'pac_any' && !(pac > 0 || (subs.cassette || 0) + (subs.floor || 0) + (subs.ceiling || 0) + (subs.wall || 0) + (subs.duct || 0) + (subs.other || 0) + (subs.unknown || 0) > 0)) return false;
          if (filterUnitType === 'hex' && !(hex > 0)) return false;
          if (filterUnitType === 'fcu' && !(fcu > 0)) return false;
          if (filterUnitType === 'other' && !other) return false;
        }

        if (filterEquip) {
          if (filterEquip === '__SELF_ONLY__') {
            if ((r.notes || '').includes('【Lic作成分】')) return false;
          } else {
            const combined = `${r.equipment || ''} ${r.access || ''} ${r.notes || ''}`;
            if (!combined.includes(filterEquip)) return false;
          }
        }

        if (filterPhoto) {
          const p = this.normalizePhotos(r);
          const totalP = p.entrance.length + p.room.length + p.equipment.length;
          if (filterPhoto === 'has_photo' && totalP === 0) return false;
          if (filterPhoto === 'missing_photo' && (p.entrance.length > 0 && p.room.length > 0)) return false;
        }

        if (searchWord) {
          const targetStr = this.buildRecordSearchText(r);
          if (!this.matchesSearchQuery(targetStr, searchWord)) return false;
        }
        return true;
      });
    }

    // 並べ替え（ソート）
    const sortOrder = document.getElementById('sort-order-select')?.value || 'hierarchy';
    const parkRank = { TDS: 1, TDL: 2, HOTEL: 3, OTHER: 4 };

    list.sort((a, b) => {
      if (sortOrder === 'date-desc') {
        return new Date(b.createdAt) - new Date(a.createdAt);
      }
      if (sortOrder === 'date-asc') {
        return new Date(a.createdAt) - new Date(b.createdAt);
      }
      if (sortOrder === 'facility-asc') {
        return (a.facility || '').localeCompare(b.facility || '', 'ja') ||
               (this.parseFloorOrder(a.floor) - this.parseFloorOrder(b.floor)) ||
               (a.room || '').localeCompare(b.room || '', 'ja');
      }
      if (sortOrder === 'floor-asc') {
        return (this.parseFloorOrder(a.floor) - this.parseFloorOrder(b.floor)) ||
               (a.facility || '').localeCompare(b.facility || '', 'ja') ||
               (a.room || '').localeCompare(b.room || '', 'ja');
      }
      if (sortOrder === 'units-desc') {
        const ua = a.totalUnits || ((a.pacCount || 0) + (a.hexCount || 0) + (a.fcuCount || 0));
        const ub = b.totalUnits || ((b.pacCount || 0) + (b.hexCount || 0) + (b.fcuCount || 0));
        return ub - ua;
      }
      if (sortOrder === 'units-asc') {
        const ua = a.totalUnits || ((a.pacCount || 0) + (a.hexCount || 0) + (a.fcuCount || 0));
        const ub = b.totalUnits || ((b.pacCount || 0) + (b.hexCount || 0) + (b.fcuCount || 0));
        return ua - ub;
      }
      if (sortOrder === 'ladder-desc') {
        return (this.parseMaxLadder(b.equipment) - this.parseMaxLadder(a.equipment)) ||
               (a.facility || '').localeCompare(b.facility || '', 'ja');
      }
      // デフォルト: 'hierarchy' (パーク ＞ エリア ＞ 施設 ＞ 階層 ＞ 部屋)
      const pa = parkRank[a.park] || 9;
      const pb = parkRank[b.park] || 9;
      if (pa !== pb) return pa - pb;
      const areaCmp = (a.area || '').localeCompare(b.area || '', 'ja');
      if (areaCmp !== 0) return areaCmp;
      const facCmp = (a.facility || '').localeCompare(b.facility || '', 'ja');
      if (facCmp !== 0) return facCmp;
      const flCmp = this.parseFloorOrder(a.floor) - this.parseFloorOrder(b.floor);
      if (flCmp !== 0) return flCmp;
      return (a.room || '').localeCompare(b.room || '', 'ja');
    });

    return list;
  }

  // 絞り込み結果のリアルタイム集計バーを更新
  renderFilteredStatsBar(filtered) {
    const bar = document.getElementById('filtered-stats-bar');
    if (!bar) return;

    if (this.records.length === 0) {
      bar.innerHTML = '<span class="text-xs text-muted">データを登録すると、ここに機種別・部屋数のリアルタイム集計が表示されます</span>';
      return;
    }

    let totalUnits = 0;
    let cas = 0, flr = 0, ceil = 0, wall = 0, duct = 0, pacOth = 0, pacUnk = 0, hex = 0, fcu = 0;
    const facSet = new Set();

    filtered.forEach(r => {
      if (r.facility) facSet.add(`${r.park}:${r.facility}`);
      const subs = r.pacSubtypes || {};
      const cCas = subs.cassette || 0;
      const cFlr = subs.floor || 0;
      const cCeil = subs.ceiling || 0;
      const cWall = subs.wall || 0;
      const cDuct = subs.duct || 0;
      const cOth = subs.other || (r.pacCount && !cCas && !cFlr && !cCeil && !cWall && !cDuct && !subs.unknown ? r.pacCount : 0);
      const cUnk = subs.unknown || 0;
      cas += cCas;
      flr += cFlr;
      ceil += cCeil;
      wall += cWall;
      duct += cDuct;
      pacOth += cOth;
      pacUnk += cUnk;
      hex += (r.hexCount || 0);
      fcu += (r.fcuCount || 0);
      totalUnits += (r.totalUnits || ((r.pacCount || 0) + (r.hexCount || 0) + (r.fcuCount || 0)));
    });

    const pills = [
      `<span class="stat-pill cyan">🏰 施設: ${facSet.size}ヶ所</span>`,
      `<span class="stat-pill cyan">🚪 部屋: ${filtered.length}室</span>`,
      `<span class="stat-pill highlight">❄️ 空調機総数: ${totalUnits}台</span>`
    ];
    if (cas > 0) pills.push(`<span class="stat-pill">天カセ: ${cas}台</span>`);
    if (flr > 0) pills.push(`<span class="stat-pill">床置: ${flr}台</span>`);
    if (ceil > 0) pills.push(`<span class="stat-pill">天吊: ${ceil}台</span>`);
    if (wall > 0) pills.push(`<span class="stat-pill">壁掛: ${wall}台</span>`);
    if (duct > 0) pills.push(`<span class="stat-pill">ダクト: ${duct}台</span>`);
    if (pacOth > 0) pills.push(`<span class="stat-pill">他PAC: ${pacOth}台</span>`);
    if (pacUnk > 0) pills.push(`<span class="stat-pill">確認中: ${pacUnk}台</span>`);
    if (hex > 0) pills.push(`<span class="stat-pill">🔄 全熱: ${hex}台</span>`);
    if (fcu > 0) pills.push(`<span class="stat-pill">💨 FCU: ${fcu}台</span>`);

    bar.innerHTML = pills.join('');
  }

  // 一覧レンダリング（6種のまとめ方に対応）
  renderRecordsList() {
    const container = document.getElementById('records-container');
    const emptyState = document.getElementById('empty-state');
    const countText = document.getElementById('filtered-count-text');

    const filtered = this.getFilteredAndSortedRecords(false);
    this.renderFilteredStatsBar(filtered);

    const viewNames = {
      card: '部屋カード一覧',
      tree: '階層ツリーまとめ',
      equip: '空調機種別集計',
      gear: '必要機材・アクセス別',
      spec: 'フィルター仕様別',
      table: '表プレビュー'
    };
    const modeLabel = viewNames[this.listViewMode] || '一覧';
    countText.textContent = `【${modeLabel}】全 ${this.records.length} 件中 ${filtered.length} 件表示`;

    if (this.records.length === 0) {
      container.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state"><h3>条件に一致するデータがありません</h3><p class="text-xs text-muted mt-1">上の「🔄 条件リセット」ボタンを押すと全件表示に戻ります。</p></div>';
      return;
    }

    if (this.listViewMode === 'tree') {
      container.innerHTML = this.renderTreeGroupedView(filtered);
      return;
    }
    if (this.listViewMode === 'equip') {
      container.innerHTML = this.renderEquipmentGroupedView(filtered);
      return;
    }
    if (this.listViewMode === 'gear') {
      container.innerHTML = this.renderGearGroupedView(filtered);
      return;
    }
    if (this.listViewMode === 'spec') {
      container.innerHTML = this.renderSpecGroupedView(filtered);
      return;
    }
    if (this.listViewMode === 'table') {
      container.innerHTML = this.renderInlineTableView(filtered);
      return;
    }

    // 標準: 'card' (部屋カード表示)
    container.innerHTML = filtered.map(r => this.renderSingleRecordCard(r)).join('');
  }

  renderSingleRecordCard(r) {
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
            <img src="${p.dataUrl}" alt="${p.label}" onclick="app.showModalPhoto('${p.dataUrl}', '${this.escapeHtml(r.facility)} - ${this.escapeHtml(r.room)} (${p.badge})')">
            <span class="photo-type-tag">${p.badge}</span>
          </div>
        `).join('')}
      </div>
    ` : '';

    const unitBadges = this.buildUnitBadgesHtml(r);
    const equipUnitsHtml = unitBadges.length > 0 ? `
      <div class="info-row">
        <span class="info-label">❄️ 空調機器:</span>
        <div class="info-value equip-badge-group">${unitBadges.join('')}</div>
      </div>
    ` : '';

    const comp = this.getRecordCompletionSummary(r);
    let workBadge = '';
    let cardWorkClass = '';
    if (comp.isAllDone) {
      workBadge = `<span class="badge-work-done">✅ 作業完了</span>`;
      cardWorkClass = 'is-completed';
    } else if (comp.isAnyDone) {
      workBadge = `<span class="badge-work-partial">⚡ 一部完了 (${comp.doneCount}/${comp.totalCount})</span>`;
      cardWorkClass = 'is-partial';
    } else {
      workBadge = `<span class="badge-work-pending">⏳ 未着手</span>`;
      cardWorkClass = '';
    }

    return `
      <div class="record-card ${cardWorkClass}">
        <div class="card-header-path">
          <div class="path-tag-row">
            <span class="park-tag ${parkClass}">${r.park}</span>
            <span class="area-tag">${this.escapeHtml(r.area || 'エリア未設定')}</span>
            ${workBadge}
          </div>
          <div class="facility-title">${this.escapeHtml(r.facility || '施設未設定')}</div>
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
  }

  buildUnitBadgesHtml(r) {
    const pac = r.pacCount || 0;
    const subs = r.pacSubtypes || {};
    const hex = r.hexCount || 0;
    const fcu = r.fcuCount || 0;
    const total = r.totalUnits || (pac + hex + fcu);
    const other = r.otherEquipment || '';

    const unitBadges = [];
    if (total > 0) {
      unitBadges.push(`<span class="badge-unit badge-total-num">計: ${total}台</span>`);
    }
    let hasPacSub = false;
    if (subs.cassette > 0) { unitBadges.push(`<span class="badge-unit badge-pac-cas">❄️ 天カセ:${subs.cassette}</span>`); hasPacSub = true; }
    if (subs.floor > 0) { unitBadges.push(`<span class="badge-unit badge-pac-floor">❄️ 床置:${subs.floor}</span>`); hasPacSub = true; }
    if (subs.ceiling > 0) { unitBadges.push(`<span class="badge-unit badge-pac-ceil">❄️ 天吊:${subs.ceiling}</span>`); hasPacSub = true; }
    if (subs.wall > 0) { unitBadges.push(`<span class="badge-unit badge-pac-wall">❄️ 壁掛:${subs.wall}</span>`); hasPacSub = true; }
    if (subs.duct > 0) { unitBadges.push(`<span class="badge-unit badge-pac-duct">❄️ ダクト:${subs.duct}</span>`); hasPacSub = true; }
    if (subs.other > 0) { unitBadges.push(`<span class="badge-unit badge-pac-other">❄️ 他PAC:${subs.other}</span>`); hasPacSub = true; }
    if (subs.unknown > 0) { unitBadges.push(`<span class="badge-unit badge-pac-unk">❄️ 確認中:${subs.unknown}</span>`); hasPacSub = true; }
    if (!hasPacSub && pac > 0) {
      unitBadges.push(`<span class="badge-unit badge-pac">❄️ PAC:${pac}</span>`);
    }
    if (hex > 0) unitBadges.push(`<span class="badge-unit badge-hex">🔄 全熱:${hex}</span>`);
    if (fcu > 0) unitBadges.push(`<span class="badge-unit badge-fcu">💨 FCU:${fcu}</span>`);
    if (other) unitBadges.push(`<span class="badge-unit">${this.escapeHtml(other)}</span>`);
    return unitBadges;
  }

  // ビュー②: 🌳 階層ツリーまとめ (パーク ＞ エリア ＞ 施設 ＞ 階層)
  renderTreeGroupedView(records) {
    const facilityMap = new Map();
    records.forEach(r => {
      const key = `${r.park}__${r.area || '(エリア未設定)'}__${r.facility || '(施設未設定)'}`;
      if (!facilityMap.has(key)) {
        facilityMap.set(key, {
          park: r.park,
          area: r.area || '(エリア未設定)',
          facility: r.facility || '(施設未設定)',
          totalUnits: 0,
          rooms: []
        });
      }
      const g = facilityMap.get(key);
      const u = r.totalUnits || ((r.pacCount || 0) + (r.hexCount || 0) + (r.fcuCount || 0));
      g.totalUnits += u;
      g.rooms.push(r);
    });

    return Array.from(facilityMap.values()).map(g => {
      const parkClass = (g.park || '').toLowerCase();
      // 階層ごとにサブグループ化
      const floorMap = new Map();
      g.rooms.forEach(r => {
        const fl = r.floor || '階層未設定';
        if (!floorMap.has(fl)) floorMap.set(fl, []);
        floorMap.get(fl).push(r);
      });

      const sortedFloors = Array.from(floorMap.entries()).sort((a, b) => this.parseFloorOrder(a[0]) - this.parseFloorOrder(b[0]));

      const floorsHtml = sortedFloors.map(([floorName, rmList]) => {
        const floorUnits = rmList.reduce((acc, r) => acc + (r.totalUnits || ((r.pacCount || 0) + (r.hexCount || 0) + (r.fcuCount || 0))), 0);
        const roomsHtml = rmList.map(r => `
          <div class="compact-room-row">
            <div class="compact-room-main">
              <span class="compact-room-name">📍 ${this.escapeHtml(r.room)}</span>
              <span class="compact-room-sub">
                ${r.equipment ? `🧰 ${this.escapeHtml(r.equipment)}` : ''}
                ${r.access ? ` / 🚪 ${this.escapeHtml(r.access)}` : ''}
                ${r.filterSpec ? ` / 📐 ${this.escapeHtml(r.filterSpec)}` : ''}
              </span>
            </div>
            <div class="compact-room-right">
              ${this.buildUnitBadgesHtml(r).join('')}
              <button type="button" class="btn btn-sub btn-sm" onclick="app.editRecord('${r.id}')">✏️</button>
              <button type="button" class="btn btn-sub btn-sm" onclick="app.duplicateRecord('${r.id}')">📑</button>
            </div>
          </div>
        `).join('');

        return `
          <div class="group-sub-floor">
            <div class="group-sub-floor-title">
              <span>🏢 ${this.escapeHtml(floorName)} （${rmList.length}室）</span>
              <span>計 ${floorUnits}台</span>
            </div>
            ${roomsHtml}
          </div>
        `;
      }).join('');

      return `
        <div class="group-section-card">
          <div class="group-section-header">
            <div class="group-section-title">
              <span class="park-tag ${parkClass}">${g.park}</span>
              <span>${this.escapeHtml(g.area)} ＞ <strong>${this.escapeHtml(g.facility)}</strong></span>
            </div>
            <div class="group-section-badges">
              <span class="stat-pill cyan">全 ${g.rooms.length} 室</span>
              <span class="stat-pill highlight">空調機 計 ${g.totalUnits} 台</span>
            </div>
          </div>
          <div class="group-section-body">
            ${floorsHtml}
          </div>
        </div>
      `;
    }).join('');
  }

  // ビュー③: ❄️ 空調機種別集計まとめ
  renderEquipmentGroupedView(records) {
    const categories = [
      { key: 'cassette', label: '❄️ パッケージ (天カセ)', badgeClass: 'badge-pac-cas', getter: r => r.pacSubtypes?.cassette || 0 },
      { key: 'floor', label: '❄️ パッケージ (床置き)', badgeClass: 'badge-pac-floor', getter: r => r.pacSubtypes?.floor || 0 },
      { key: 'ceiling', label: '❄️ パッケージ (天吊り)', badgeClass: 'badge-pac-ceil', getter: r => r.pacSubtypes?.ceiling || 0 },
      { key: 'wall', label: '❄️ パッケージ (壁掛け)', badgeClass: 'badge-pac-wall', getter: r => r.pacSubtypes?.wall || 0 },
      { key: 'duct', label: '❄️ パッケージ (隠蔽ダクト)', badgeClass: 'badge-pac-duct', getter: r => r.pacSubtypes?.duct || 0 },
      { key: 'pac_other', label: '❄️ パッケージ (その他)', badgeClass: 'badge-pac-other', getter: r => {
        const s = r.pacSubtypes || {};
        return s.other || (r.pacCount && !s.cassette && !s.floor && !s.ceiling && !s.wall && !s.duct && !s.unknown ? r.pacCount : 0);
      }},
      { key: 'pac_unknown', label: '❄️ パッケージ (種別確認中)', badgeClass: 'badge-pac-unk', getter: r => r.pacSubtypes?.unknown || 0 },
      { key: 'hex', label: '🔄 全熱交換器 (HEX)', badgeClass: 'badge-hex', getter: r => r.hexCount || 0 },
      { key: 'fcu', label: '💨 ファンコイル (FCU)', badgeClass: 'badge-fcu', getter: r => r.fcuCount || 0 },
      { key: 'other_eq', label: '⚙️ その他機器 (AHU・ファン等)', badgeClass: 'badge-pac-other', getter: r => (r.otherEquipment ? 1 : 0) }
    ];

    const blocks = categories.map(cat => {
      const matched = [];
      let sumUnits = 0;
      records.forEach(r => {
        const cnt = cat.getter(r);
        if (cnt > 0) {
          sumUnits += cnt;
          matched.push({ r, cnt });
        }
      });
      if (matched.length === 0) return '';

      const rowsHtml = matched.map(({ r, cnt }) => `
        <div class="compact-room-row">
          <div class="compact-room-main">
            <span class="compact-room-name">[${r.park}] ${this.escapeHtml(r.facility)} ＞ ${this.escapeHtml(r.floor || '-')} ＞ 📍 ${this.escapeHtml(r.room)}</span>
            <span class="compact-room-sub">
              ${r.filterSpec ? `📐 仕様: ${this.escapeHtml(r.filterSpec)}` : '仕様未記入'}
              ${r.machineNo ? ` (${this.escapeHtml(r.machineNo)})` : ''}
              ${r.equipment ? ` / 🧰 ${this.escapeHtml(r.equipment)}` : ''}
            </span>
          </div>
          <div class="compact-room-right">
            <span class="badge-unit ${cat.badgeClass}">${cat.key === 'other_eq' ? this.escapeHtml(r.otherEquipment) : `${cnt}台`}</span>
            <button type="button" class="btn btn-sub btn-sm" onclick="app.editRecord('${r.id}')">✏️</button>
          </div>
        </div>
      `).join('');

      return `
        <div class="group-section-card">
          <div class="group-section-header">
            <div class="group-section-title">${cat.label}</div>
            <div class="group-section-badges">
              <span class="stat-pill cyan">設置: ${matched.length} 室</span>
              <span class="stat-pill highlight">合計: ${sumUnits} ${cat.key === 'other_eq' ? '件' : '台'}</span>
            </div>
          </div>
          <div class="group-section-body">${rowsHtml}</div>
        </div>
      `;
    }).filter(Boolean);

    return blocks.length > 0 ? blocks.join('') : '<div class="empty-state"><h3>空調機台数が登録されている部屋がありません</h3></div>';
  }

  // ビュー④: 🪜 必要機材・アクセスルート別まとめ
  renderGearGroupedView(records) {
    const gearMap = new Map();
    const knownTags = ['12尺', '10尺', '9尺', '8尺', '7尺', '6尺', '5尺', '4尺', '3尺', '脚立不要', 'フィルター', 'バキューム', '養生', 'ハーネス', 'ヘッドライト', 'バックステージ', 'オンステージ', '屋上', '鍵'];

    records.forEach(r => {
      const text = `${r.equipment || ''} ${r.access || ''}`.trim();
      const matchedTags = knownTags.filter(t => text.includes(t));
      if (matchedTags.length === 0) {
        const fallback = (r.equipment || '').trim() || '機材・アクセス未記入';
        if (!gearMap.has(fallback)) gearMap.set(fallback, []);
        gearMap.get(fallback).push(r);
      } else {
        matchedTags.forEach(tag => {
          if (!gearMap.has(tag)) gearMap.set(tag, []);
          gearMap.get(tag).push(r);
        });
      }
    });

    return Array.from(gearMap.entries()).map(([tag, rmList]) => {
      const totalU = rmList.reduce((acc, r) => acc + (r.totalUnits || ((r.pacCount || 0) + (r.hexCount || 0) + (r.fcuCount || 0))), 0);
      const rowsHtml = rmList.map(r => `
        <div class="compact-room-row">
          <div class="compact-room-main">
            <span class="compact-room-name">[${r.park}] ${this.escapeHtml(r.facility)} (${this.escapeHtml(r.floor || '-')}) 📍 ${this.escapeHtml(r.room)}</span>
            <span class="compact-room-sub">🧰 ${this.escapeHtml(r.equipment || '-')} / 🚪 ${this.escapeHtml(r.access || '-')}</span>
          </div>
          <div class="compact-room-right">
            ${this.buildUnitBadgesHtml(r).join('')}
            <button type="button" class="btn btn-sub btn-sm" onclick="app.editRecord('${r.id}')">✏️</button>
          </div>
        </div>
      `).join('');

      return `
        <div class="group-section-card">
          <div class="group-section-header">
            <div class="group-section-title">🪜 【${this.escapeHtml(tag)}】が必要な部屋</div>
            <div class="group-section-badges">
              <span class="stat-pill cyan">対象: ${rmList.length} 室</span>
              <span class="stat-pill highlight">機器計: ${totalU} 台</span>
            </div>
          </div>
          <div class="group-section-body">${rowsHtml}</div>
        </div>
      `;
    }).join('');
  }

  // ビュー⑤: 📐 フィルター仕様・機番別まとめ
  renderSpecGroupedView(records) {
    const specMap = new Map();
    records.forEach(r => {
      const key = (r.filterSpec || '').trim() || '(フィルター仕様・寸法 未記入)';
      if (!specMap.has(key)) specMap.set(key, []);
      specMap.get(key).push(r);
    });

    return Array.from(specMap.entries()).map(([spec, rmList]) => {
      const totalU = rmList.reduce((acc, r) => acc + (r.totalUnits || ((r.pacCount || 0) + (r.hexCount || 0) + (r.fcuCount || 0))), 0);
      const rowsHtml = rmList.map(r => `
        <div class="compact-room-row">
          <div class="compact-room-main">
            <span class="compact-room-name">[${r.park}] ${this.escapeHtml(r.facility)} (${this.escapeHtml(r.floor || '-')}) 📍 ${this.escapeHtml(r.room)}</span>
            <span class="compact-room-sub">⚙️ 機番: ${this.escapeHtml(r.machineNo || '-')} / ❄️ ${this.escapeHtml(r.equipSummary || '-')}</span>
          </div>
          <div class="compact-room-right">
            ${this.buildUnitBadgesHtml(r).join('')}
            <button type="button" class="btn btn-sub btn-sm" onclick="app.editRecord('${r.id}')">✏️</button>
          </div>
        </div>
      `).join('');

      return `
        <div class="group-section-card">
          <div class="group-section-header">
            <div class="group-section-title">📐 フィルター仕様: ${this.escapeHtml(spec)}</div>
            <div class="group-section-badges">
              <span class="stat-pill cyan">該当: ${rmList.length} 室</span>
              <span class="stat-pill highlight">対象機器: ${totalU} 台</span>
            </div>
          </div>
          <div class="group-section-body">${rowsHtml}</div>
        </div>
      `;
    }).join('');
  }

  // ビュー⑥: 📊 一覧タブ内でのスプレッドシート表プレビュー
  renderInlineTableView(records) {
    const rows = this.getExpandedRows(records);
    const trs = rows.map(r => `
      <tr>
        <td>${r.no}</td>
        <td><strong>${r.park}</strong></td>
        <td>${this.escapeHtml(r.area)}</td>
        <td><strong>${this.escapeHtml(r.facility)}</strong></td>
        <td style="text-align:center;">${this.escapeHtml(r.floor || '-')}</td>
        <td><strong style="color:#38bdf8;">${this.escapeHtml(r.room)}</strong></td>
        <td><strong>${this.escapeHtml(r.equipType)}</strong></td>
        <td style="text-align:center; color:#fbbf24; font-weight:700;">${this.escapeHtml(r.equipCount)}</td>
        <td>${this.escapeHtml(r.equipment || '-')}</td>
        <td>${this.escapeHtml(r.access || '-')}</td>
        <td>${this.escapeHtml(r.filterSpec || '-')}</td>
        <td>${this.escapeHtml(r.machineNo || '-')}</td>
        <td>${this.escapeHtml(r.notes || '')}</td>
      </tr>
    `).join('');

    return `
      <div class="card">
        <div class="table-scroll-container">
          <table class="spreadsheet-table">
            <thead>
              <tr>
                <th>No</th><th>パーク</th><th>エリア</th><th>施設</th><th>階層</th><th>部屋名</th>
                <th>空調機種別</th><th>台数</th><th>必要なもの</th><th>アクセス</th><th>フィルター仕様</th><th>機番</th><th>備考</th>
              </tr>
            </thead>
            <tbody>${trs}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ================= 9. スプレッドシート連携（5種のまとめ方シート出力・A4縦印刷対応） =================
  getExportContextInfo(overrideSource = null) {
    const source = overrideSource || document.getElementById('export-filter-source')?.value || 'list';
    if (source === 'checklist') {
      const records = this.getFilteredChecklistRecords();
      const mf = this.checkMultiFilters || { park: [], area: [], facility: [], floor: [], unitType: [], equipment: [] };
      const status = this.checkStatusFilter || 'all';
      const parts = [];
      if (status === 'pending') parts.push('未着手のみ');
      else if (status === 'completed') parts.push('完了済みのみ');
      if (mf.park.length > 0) parts.push(`パーク=${mf.park.join(', ')}`);
      if (mf.area.length > 0) parts.push(`エリア=${mf.area.join(', ')}`);
      if (mf.facility.length > 0) parts.push(`施設=${mf.facility.join(', ')}`);
      if (mf.floor.length > 0) parts.push(`階層=${mf.floor.join(', ')}`);
      if (mf.unitType.length > 0) {
        parts.push(`機種=${mf.unitType.map(u => this.getUnitTypeLabel(u)).join(', ')}`);
      }
      if (mf.equipment.length > 0) parts.push(`機材=${mf.equipment.join(', ')}`);
      return {
        source,
        records,
        filterUnitType: mf.unitType,
        conditionLabel: parts.length > 0 ? parts.join(' / ') : '作業チェック全件'
      };
    }
    if (source === 'all') {
      return {
        source,
        records: this.getFilteredAndSortedRecords(true),
        filterUnitType: [],
        conditionLabel: '登録データ全件'
      };
    }
    // デフォルト: list (階層リストタブの条件)
    const unitSel = document.getElementById('filter-unit-type-select')?.value || '';
    return {
      source: 'list',
      records: this.getFilteredAndSortedRecords(false),
      filterUnitType: unitSel ? [unitSel] : [],
      conditionLabel: this.hasActiveFilters() ? '階層リスト絞込中' : '全件対象'
    };
  }

  getTargetRecordsForExport(overrideSource = null) {
    return this.getExportContextInfo(overrideSource).records;
  }

  getExpandedRows(sourceRecords = null, filterUnitType = '') {
    const targetList = sourceRecords || this.getTargetRecordsForExport();
    const expanded = [];
    let no = 1;

    targetList.forEach(r => {
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
      const cDuct = subs.duct || 0;
      const cOth = subs.other || (r.pacCount && !cCas && !cFloor && !cCeil && !cWall && !cDuct && !subs.unknown ? r.pacCount : 0);
      const cUnk = subs.unknown || 0;

      let pacHandled = false;
      if (cCas > 0) { items.push({ key: 'cassette', typeGroup: 'pac', type: 'パッケージ (天カセ)', count: `${cCas}台`, num: cCas }); pacHandled = true; }
      if (cFloor > 0) { items.push({ key: 'floor', typeGroup: 'pac', type: 'パッケージ (床置き)', count: `${cFloor}台`, num: cFloor }); pacHandled = true; }
      if (cCeil > 0) { items.push({ key: 'ceiling', typeGroup: 'pac', type: 'パッケージ (天吊り)', count: `${cCeil}台`, num: cCeil }); pacHandled = true; }
      if (cWall > 0) { items.push({ key: 'wall', typeGroup: 'pac', type: 'パッケージ (壁掛け)', count: `${cWall}台`, num: cWall }); pacHandled = true; }
      if (cDuct > 0) { items.push({ key: 'duct', typeGroup: 'duct', type: 'パッケージ (隠蔽ダクト)', count: `${cDuct}台`, num: cDuct }); pacHandled = true; }
      if (cOth > 0) { items.push({ key: 'other_pac', typeGroup: 'pac', type: 'パッケージ (その他)', count: `${cOth}台`, num: cOth }); pacHandled = true; }
      if (cUnk > 0) { items.push({ key: 'unknown_pac', typeGroup: 'pac', type: 'パッケージ (種別確認中)', count: `${cUnk}台`, num: cUnk }); pacHandled = true; }

      if (!pacHandled && pac > 0) {
        items.push({ key: 'pac', typeGroup: 'pac', type: 'パッケージ (PAC)', count: `${pac}台`, num: pac });
      }

      if (hex > 0) items.push({ key: 'hex', typeGroup: 'hex', type: '全熱交換器 (HEX)', count: `${hex}台`, num: hex });
      if (fcu > 0) items.push({ key: 'fcu', typeGroup: 'fcu', type: 'ファンコイル (FCU)', count: `${fcu}台`, num: fcu });
      if (other) items.push({ key: 'other', typeGroup: 'other', type: 'その他機器', count: other, num: 1 });

      if (items.length === 0) {
        items.push({ key: null, typeGroup: 'other', type: '空調機未登録', count: '-', num: 0 });
      }

      // 対象機種の絞り込みがある場合は該当機器のみ抽出（配列・単一文字の両対応）
      const unitFilterArr = this.normalizeUnitFilterArray(filterUnitType);
      const finalItems = unitFilterArr.length > 0
        ? items.filter(it => this.equipKeyMatchesFilterArray(it.key, unitFilterArr))
        : items;

      finalItems.forEach((item, idxInRoom) => {
        const itemCompleted = item.key ? this.isEquipCompleted(r, item.key) : !!r.completed;
        expanded.push({
          no: no++,
          recordId: r.id,
          isRoomStart: idxInRoom === 0,
          equipKey: item.key,
          typeGroup: item.typeGroup,
          completed: itemCompleted,
          completedAt: r.completedAt || null,
          park: r.park,
          area: r.area,
          facility: r.facility,
          floor: r.floor || '',
          room: r.room,
          equipType: item.type,
          equipCount: item.count,
          equipNum: item.num,
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

  // 5種類のシート形式（⑤作業チェック表 / ①機器別詳細 / ②部屋別1行まとめ / ③施設・階層別集計 / ④機種・仕様別集計）のデータ生成
  buildSheetDataset(mode, sourceRecords = null, overrideFilterUnit = null, overrideCheckMode = null) {
    const ctx = this.getExportContextInfo();
    const records = sourceRecords || ctx.records;
    const filterUnit = overrideFilterUnit !== null ? overrideFilterUnit : ctx.filterUnitType;
    const checkMode = overrideCheckMode || document.getElementById('export-check-mark-mode')?.value || 'blank';

    // ⑤ 作業チェック表（A4縦・紙＆スプレッドシートチェック欄付・施設と部屋名メイン・フィルター仕様なし）
    if (mode === 'checklist_print') {
      const exp = this.getExpandedRows(records, filterUnit);
      const headers = [
        '済', 'No', '施設/アトラクション', '階層', '部屋名',
        '点検対象機器', '台数', '必要なもの', 'アクセス方法', '備考・特記事項', '現場メモ / 作業日時', 'パーク', 'エリア'
      ];
      const rows = exp.map(r => {
        const isChecked = (checkMode === 'sync') && r.completed;
        let memoCell = '';
        if (isChecked && r.completedAt) {
          try {
            const d = new Date(r.completedAt);
            memoCell = `済 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          } catch (e) {
            memoCell = '済';
          }
        }
        return [
          isChecked ? '☑' : '□',
          r.no,
          r.facility || '-',
          r.floor || '-',
          r.room || '-',
          r.equipType,
          r.equipCount,
          r.equipment || '-',
          r.access || '-',
          r.notes || '',
          memoCell,
          r.park,
          r.area || '-'
        ];
      });
      const colWidths = [
        { wch: 5 }, { wch: 5 }, { wch: 24 }, { wch: 7 }, { wch: 22 },
        { wch: 20 }, { wch: 8 }, { wch: 22 }, { wch: 20 }, { wch: 26 }, { wch: 16 }, { wch: 7 }, { wch: 18 }
      ];
      return { sheetName: '⑤作業チェック表', title: '☑️ ⑤ 作業チェック表 (施設・部屋名メイン / A4縦用)', headers, rows, colWidths };
    }

    // ① 機器別詳細リスト（20列・作業状況列付）
    if (mode === 'expanded') {
      const exp = this.getExpandedRows(records, filterUnit);
      const headers = [
        'No', '作業状況', '完了日時', 'パーク', 'エリア', '施設/アトラクション', '階層', '部屋名',
        '空調機種別', '台数', '作業に必要なもの', 'アクセス方法',
        '建物入口写真', '部屋写真', '機器写真',
        'フィルター仕様', '機番・系統', '特記事項', '階層フルパス', '登録日時'
      ];
      const rows = exp.map(r => [
        r.no,
        r.completed ? '完了' : '未着手',
        r.completedAt ? new Date(r.completedAt).toLocaleString('ja-JP') : '-',
        r.park, r.area, r.facility, r.floor || '-', r.room,
        r.equipType, r.equipCount, r.equipment || '-', r.access || '-',
        r.entrancePhotos.length > 0 ? `あり(${r.entrancePhotos.length}枚)` : 'なし',
        r.roomPhotos.length > 0 ? `あり(${r.roomPhotos.length}枚)` : 'なし',
        r.equipPhotos.length > 0 ? `あり(${r.equipPhotos.length}枚)` : 'なし',
        r.filterSpec || '-', r.machineNo || '-', r.notes || '',
        r.fullPath, new Date(r.createdAt).toLocaleString('ja-JP')
      ]);
      const colWidths = [
        { wch: 5 }, { wch: 10 }, { wch: 18 }, { wch: 8 }, { wch: 20 }, { wch: 24 }, { wch: 8 }, { wch: 18 },
        { wch: 20 }, { wch: 9 }, { wch: 28 }, { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
        { wch: 20 }, { wch: 14 }, { wch: 24 }, { wch: 42 }, { wch: 18 }
      ];
      return { sheetName: '①機器別詳細リスト', title: '📋 ① 機器別詳細リスト (作業状況付・20列)', headers, rows, colWidths };
    }

    // ② 部屋別まとめリスト（1部屋1行・作業状況列付）
    if (mode === 'room_summary') {
      const headers = [
        'No', '作業状況', '完了日時', 'パーク', 'エリア', '施設/アトラクション', '階層', '部屋名',
        '合計台数', '天カセ', '床置き', '天吊り', '壁掛け', 'ダクト', '他PAC', '確認中', '全熱(HEX)', 'FCU', 'その他機器',
        '作業に必要なもの', 'アクセス方法', 'フィルター仕様', '機番・系統', '特記事項'
      ];
      const rows = records.map((r, idx) => {
        const s = r.pacSubtypes || {};
        const cCas = s.cassette || 0;
        const cFlr = s.floor || 0;
        const cCeil = s.ceiling || 0;
        const cWall = s.wall || 0;
        const cDuct = s.duct || 0;
        const cOth = s.other || (r.pacCount && !cCas && !cFlr && !cCeil && !cWall && !cDuct && !s.unknown ? r.pacCount : 0);
        const cUnk = s.unknown || 0;
        const hex = r.hexCount || 0;
        const fcu = r.fcuCount || 0;
        const tot = r.totalUnits || ((r.pacCount || 0) + hex + fcu);
        const comp = this.getRecordCompletionSummary(r);
        const statusText = comp.isAllDone ? '完了' : (comp.isAnyDone ? `一部完了 (${comp.doneCount}/${comp.totalCount})` : '未着手');
        return [
          idx + 1,
          statusText,
          r.completedAt ? new Date(r.completedAt).toLocaleString('ja-JP') : '-',
          r.park, r.area, r.facility, r.floor || '-', r.room,
          `${tot}台`, cCas || '-', cFlr || '-', cCeil || '-', cWall || '-', cDuct || '-', cOth || '-', cUnk || '-', hex || '-', fcu || '-', r.otherEquipment || '-',
          r.equipment || '-', r.access || '-', r.filterSpec || '-', r.machineNo || '-', r.notes || ''
        ];
      });
      const colWidths = [
        { wch: 5 }, { wch: 10 }, { wch: 18 }, { wch: 8 }, { wch: 18 }, { wch: 22 }, { wch: 8 }, { wch: 18 },
        { wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 16 },
        { wch: 26 }, { wch: 26 }, { wch: 18 }, { wch: 14 }, { wch: 22 }
      ];
      return { sheetName: '②部屋別まとめリスト', title: '🏢 ② 部屋別まとめリスト (作業状況付・1部屋1行)', headers, rows, colWidths };
    }

    // ③ 施設・階層別 集計表
    if (mode === 'facility_summary') {
      const headers = [
        'No', 'パーク', 'エリア', '施設/アトラクション', '階層',
        '登録部屋数', '空調機合計', '天カセ計', '床置き計', '天吊り計', '壁掛け計', 'ダクト計', '他PAC計', '確認中計', '全熱(HEX)計', 'FCU計',
        '対象部屋一覧', '必要機材まとめ'
      ];
      const map = new Map();
      records.forEach(r => {
        const key = `${r.park}__${r.area}__${r.facility}__${r.floor || '-'}`;
        if (!map.has(key)) {
          map.set(key, {
            park: r.park, area: r.area, facility: r.facility, floor: r.floor || '-',
            roomCount: 0, total: 0, cas: 0, flr: 0, ceil: 0, wall: 0, duct: 0, oth: 0, unk: 0, hex: 0, fcu: 0,
            rooms: [], gears: new Set()
          });
        }
        const g = map.get(key);
        const s = r.pacSubtypes || {};
        g.roomCount += 1;
        g.cas += (s.cassette || 0);
        g.flr += (s.floor || 0);
        g.ceil += (s.ceiling || 0);
        g.wall += (s.wall || 0);
        g.duct += (s.duct || 0);
        g.oth += (s.other || (r.pacCount && !s.cassette && !s.floor && !s.ceiling && !s.wall && !s.duct && !s.unknown ? r.pacCount : 0));
        g.unk += (s.unknown || 0);
        g.hex += (r.hexCount || 0);
        g.fcu += (r.fcuCount || 0);
        g.total += (r.totalUnits || ((r.pacCount || 0) + (r.hexCount || 0) + (r.fcuCount || 0)));
        g.rooms.push(r.room);
        if (r.equipment) g.gears.add(r.equipment);
      });

      const rows = Array.from(map.values()).map((g, idx) => [
        idx + 1, g.park, g.area, g.facility, g.floor,
        `${g.roomCount}室`, `${g.total}台`,
        g.cas || '-', g.flr || '-', g.ceil || '-', g.wall || '-', g.duct || '-', g.oth || '-', g.unk || '-', g.hex || '-', g.fcu || '-',
        g.rooms.join(', '), Array.from(g.gears).join(' / ') || '-'
      ]);
      const colWidths = [
        { wch: 5 }, { wch: 8 }, { wch: 18 }, { wch: 24 }, { wch: 8 },
        { wch: 10 }, { wch: 10 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 11 }, { wch: 9 },
        { wch: 30 }, { wch: 28 }
      ];
      return { sheetName: '③施設・階層別集計', title: '🏰 ③ 施設・階層別 集計表', headers, rows, colWidths };
    }

    // ④ 空調機種・フィルター仕様別 集計表
    const headers = [
      'No', '空調機種区分', 'フィルター仕様・寸法', '該当部屋数', '合計台数', '設置施設・部屋一覧', '主な必要機材'
    ];
    const expRows = this.getExpandedRows(records);
    const specGroupMap = new Map();
    expRows.forEach(r => {
      const key = `${r.equipType}__${r.filterSpec || '仕様未記入'}`;
      if (!specGroupMap.has(key)) {
        specGroupMap.set(key, {
          equipType: r.equipType,
          filterSpec: r.filterSpec || '仕様未記入',
          roomCount: 0,
          totalUnits: 0,
          locations: [],
          gears: new Set()
        });
      }
      const g = specGroupMap.get(key);
      g.roomCount += 1;
      const numMatch = String(r.equipCount).match(/(\d+)/);
      g.totalUnits += numMatch ? parseInt(numMatch[1], 10) : 1;
      g.locations.push(`${r.facility}(${r.floor || '-'}:${r.room})`);
      if (r.equipment) g.gears.add(r.equipment);
    });

    const rows = Array.from(specGroupMap.values()).map((g, idx) => [
      idx + 1, g.equipType, g.filterSpec, `${g.roomCount}室`, `${g.totalUnits}台`,
      g.locations.join(', '), Array.from(g.gears).join(' / ') || '-'
    ]);
    const colWidths = [
      { wch: 5 }, { wch: 22 }, { wch: 22 }, { wch: 12 }, { wch: 12 }, { wch: 42 }, { wch: 28 }
    ];
    return { sheetName: '④機種・仕様別集計', title: '❄️ ④ 機種・フィルター仕様別 集計表', headers, rows, colWidths };
  }

  renderSpreadsheetPreview() {
    const thead = document.getElementById('spreadsheet-preview-head');
    const tbody = document.getElementById('spreadsheet-preview-body');
    const titleEl = document.getElementById('preview-table-title');
    const filterBadge = document.getElementById('export-active-filter-badge');
    if (!tbody || !thead) return;

    const ctx = this.getExportContextInfo();
    const targetRecords = ctx.records;

    if (filterBadge) {
      if (ctx.source === 'checklist') {
        filterBadge.textContent = `✅ 作業チェック連動 (${targetRecords.length}/${this.records.length}室)`;
        filterBadge.className = 'badge badge-success';
      } else if (ctx.source === 'list' && this.hasActiveFilters()) {
        filterBadge.textContent = `🔍 階層リスト絞込中 (${targetRecords.length}/${this.records.length}室)`;
        filterBadge.className = 'badge badge-success';
      } else {
        filterBadge.textContent = `全件対象 (${targetRecords.length}室)`;
        filterBadge.className = 'badge';
      }
    }

    const dataset = this.buildSheetDataset(this.exportSheetMode, targetRecords, ctx.filterUnitType);
    if (titleEl) {
      titleEl.innerHTML = `${dataset.title} (全 <span id="preview-row-count">${dataset.rows.length}</span> 行)`;
    }

    thead.innerHTML = `<tr>${dataset.headers.map(h => `<th>${this.escapeHtml(h)}</th>`).join('')}</tr>`;

    if (dataset.rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${dataset.headers.length}" style="text-align:center; padding:20px; color:#94a3b8;">データがありません</td></tr>`;
      return;
    }

    let prevFacility = null;
    tbody.innerHTML = dataset.rows.map(row => {
      // モードごとの施設列・部屋列・階層列インデックス
      let facIdx = -1, floorIdx = -1, roomIdx = -1;
      if (this.exportSheetMode === 'checklist_print') {
        facIdx = 2; floorIdx = 3; roomIdx = 4;
      } else if (this.exportSheetMode === 'expanded') {
        facIdx = 5; floorIdx = 6; roomIdx = 7;
      } else if (this.exportSheetMode === 'room_summary') {
        facIdx = 5; floorIdx = 6; roomIdx = 7;
      } else if (this.exportSheetMode === 'facility_summary') {
        facIdx = 3; floorIdx = 4;
      }

      const currentFac = facIdx >= 0 ? String(row[facIdx] ?? '') : null;
      const isFacStart = (facIdx >= 0 && prevFacility !== null && currentFac !== prevFacility);
      if (facIdx >= 0) prevFacility = currentFac;

      return `
      <tr class="${isFacStart ? 'preview-row-fac-start' : ''}">
        ${row.map((cell, idx) => {
          const val = this.escapeHtml(String(cell ?? ''));
          if (idx === facIdx) {
            return `<td class="preview-cell-facility">🏢 ${val}</td>`;
          }
          if (idx === roomIdx) {
            return `<td class="preview-cell-room">${val}</td>`;
          }
          if (idx === floorIdx) {
            return `<td style="text-align:center; color:#fbbf24; font-weight:700;">${val}</td>`;
          }
          if (this.exportSheetMode === 'checklist_print') {
            if (idx === 0) {
              const isChk = val === '☑';
              return `<td style="text-align:center; font-size:15px; font-weight:800; color:${isChk ? '#34d399' : '#e2e8f0'};">${val}</td>`;
            }
            if (idx === 5) return `<td style="color:#38bdf8; font-weight:700;">${val}</td>`;
            if (idx === 6) return `<td style="text-align:center; color:#fbbf24; font-weight:700; white-space:nowrap;">${val}</td>`;
            if (idx === 7) return `<td style="color:#fb923c; font-weight:600;">${val}</td>`;
          }
          if (idx === 8 && this.exportSheetMode === 'expanded') {
            return `<td style="color:#38bdf8; font-weight:700;">● ${val}</td>`;
          }
          if ((idx === 9 && this.exportSheetMode === 'expanded') || (idx === 8 && this.exportSheetMode === 'room_summary')) {
            return `<td style="text-align:center; color:#fbbf24; font-weight:700; white-space:nowrap;">${val}</td>`;
          }
          return `<td>${val}</td>`;
        }).join('')}
      </tr>
    `;
    }).join('');
  }

  // クリップボードTSVコピー（現在選択中のまとめ方・フィルタ結果をコピー）
  async copyToClipboardTSV() {
    const dataset = this.buildSheetDataset(this.exportSheetMode);
    if (dataset.rows.length === 0) {
      this.showToast('コピーするデータがありません', true);
      return;
    }

    const cleanCell = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ');
    const tsvContent = [
      dataset.headers.join('\t'),
      ...dataset.rows.map(r => r.map(cleanCell).join('\t'))
    ].join('\n');

    try {
      await navigator.clipboard.writeText(tsvContent);
      this.showToast(`📋 「${dataset.sheetName}」(${dataset.rows.length}行) をコピーしました！`);
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

  // CSVダウンロード（現在選択中のまとめ方・フィルタ結果）
  downloadCSV() {
    const dataset = this.buildSheetDataset(this.exportSheetMode);
    if (dataset.rows.length === 0) {
      this.showToast('ダウンロードするデータがありません', true);
      return;
    }

    const escapeCsv = (str) => {
      const s = String(str ?? '');
      if (s.includes('"') || s.includes(',') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    };

    const csvRows = dataset.rows.map(r => r.map(escapeCsv).join(','));
    const csvContent = '\uFEFF' + [dataset.headers.map(escapeCsv).join(','), ...csvRows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `TDR_空調リスト_${dataset.sheetName}_${this.getFormattedDate()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    this.showToast(`📥 CSV (${dataset.sheetName}) を保存しました`);
  }

  // Excelダウンロード（全5種類のまとめ方シートを1つのExcelブックに一括収録！）
  downloadXLSX() {
    const ctx = this.getExportContextInfo();
    const targetRecords = ctx.records;
    if (targetRecords.length === 0) {
      this.showToast('ダウンロードするデータがありません', true);
      return;
    }

    if (typeof XLSX === 'undefined') {
      this.showToast('Excelライブラリが利用できないため、CSVをダウンロードします');
      this.downloadCSV();
      return;
    }

    const wb = XLSX.utils.book_new();
    const allModes = ['checklist_print', 'expanded', 'room_summary', 'facility_summary', 'equip_summary'];
    const modesOrder = [
      this.exportSheetMode,
      ...allModes.filter(m => m !== this.exportSheetMode)
    ];

    modesOrder.forEach(mode => {
      const ds = this.buildSheetDataset(mode, targetRecords, ctx.filterUnitType);
      const aoa = [ds.headers, ...ds.rows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = ds.colWidths;
      XLSX.utils.book_append_sheet(wb, ws, ds.sheetName);
    });

    XLSX.writeFile(wb, `TDR_空調設備現場リスト_全5種集計チェック表入_${this.getFormattedDate()}.xlsx`);
    this.showToast('📗 全5シート収録のExcelファイルをダウンロードしました！');
  }

  // ================= A4縦 紙ベース作業チェックリスト プレビュー＆印刷 =================
  openChecklistPrintPreview(defaultSource = null, defaultCheckMode = null) {
    const modal = document.getElementById('checklist-print-modal');
    const srcSel = document.getElementById('print-modal-source-select');
    const chkSel = document.getElementById('print-modal-check-select');
    if (!modal) return;

    if (srcSel && defaultSource) srcSel.value = defaultSource;
    if (chkSel && defaultCheckMode) chkSel.value = defaultCheckMode;

    this.renderChecklistPrintPreview();
    modal.classList.remove('hidden');
  }

  closeChecklistPrintPreview() {
    document.getElementById('checklist-print-modal')?.classList.add('hidden');
  }

  buildChecklistPrintHtml(sourceType, checkMarkMode) {
    const ctx = this.getExportContextInfo(sourceType);
    const expRows = this.getExpandedRows(ctx.records, ctx.filterUnitType);

    const now = new Date();
    const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    const roomSet = new Set(expRows.map(r => r.recordId));
    const totalUnits = expRows.reduce((sum, r) => sum + (r.equipNum || 0), 0);
    const doneCount = checkMarkMode === 'sync' ? expRows.filter(r => r.completed).length : 0;

    if (expRows.length === 0) {
      return `
        <div style="padding:30px; text-align:center; color:#475569; font-size:11pt;">
          <strong>対象となる作業データがありません。</strong><br>
          絞り込み条件を変更してから再度お試しください。
        </div>
      `;
    }

    // 施設ごとの統計集計マップ（連続ブロック用）
    const facStats = new Map();
    expRows.forEach(r => {
      const fKey = `${r.park || ''}||${r.area || ''}||${r.facility || ''}`;
      if (!facStats.has(fKey)) {
        facStats.set(fKey, { count: 0, units: 0, rooms: new Set() });
      }
      const st = facStats.get(fKey);
      st.count += 1;
      st.units += (r.equipNum || 0);
      st.rooms.add(`${r.floor || ''}||${r.room || ''}`);
    });

    let lastFacKey = null;
    let lastRoomSig = null;
    const rowsHtml = expRows.map(r => {
      const isChecked = (checkMarkMode === 'sync') && r.completed;
      const fKey = `${r.park || ''}||${r.area || ''}||${r.facility || ''}`;
      const roomSig = `${fKey}||${r.floor || ''}||${r.room || ''}`;
      const isNewFac = (fKey !== lastFacKey);
      const isNewRoom = (roomSig !== lastRoomSig);
      lastFacKey = fKey;
      lastRoomSig = roomSig;

      let groupHeaderHtml = '';
      if (isNewFac) {
        const st = facStats.get(fKey);
        groupHeaderHtml = `
          <tr class="a4-facility-group-row">
            <td colspan="7">
              <div class="a4-fac-banner">
                <div class="a4-fac-title-wrap">
                  <span class="a4-fac-icon">🏢</span>
                  <span class="a4-fac-name">${this.escapeHtml(r.facility || '施設未設定')}</span>
                  <span class="a4-fac-area-tag">[${this.escapeHtml(r.park)}] ${this.escapeHtml(r.area || '')}</span>
                </div>
                <span class="a4-fac-count-tag">${st.rooms.size}部屋 / ${st.count}項目 (計${st.units}台)</span>
              </div>
            </td>
          </tr>
        `;
      }

      const rowClasses = [
        (!isNewFac && isNewRoom) ? 'row-room-start' : '',
        (!isNewFac && !isNewRoom) ? 'row-same-room-cont' : '',
        isChecked ? 'row-done' : ''
      ].filter(Boolean).join(' ');

      let memoHtml = '<div class="paper-memo-line"></div>';
      if (isChecked && r.completedAt) {
        try {
          const d = new Date(r.completedAt);
          const timeStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          memoHtml = `<span class="paper-memo-done">済 ${timeStr}</span>`;
        } catch (e) {
          memoHtml = `<span class="paper-memo-done">済</span>`;
        }
      }

      // 階層＋部屋名をメインに主役表示（同部屋連続時は軽くラベル補足）
      const floorBadge = r.floor ? `<span class="paper-floor-badge">${this.escapeHtml(r.floor)}</span>` : '';
      const locHtml = isNewRoom
        ? `<div class="paper-room-line">${floorBadge}<span class="paper-room-main">${this.escapeHtml(r.room || '-')}</span></div>`
        : `<div class="paper-room-line is-cont">${floorBadge}<span class="paper-room-main">${this.escapeHtml(r.room || '-')}</span><span class="paper-cont-tag">(同室別機種)</span></div>`;

      return `
        ${groupHeaderHtml}
        <tr class="${rowClasses}">
          <td class="col-chk"><span class="paper-checkbox ${isChecked ? 'checked' : ''}">${isChecked ? '✔' : ''}</span></td>
          <td class="col-no">${r.no}</td>
          <td class="col-loc">${locHtml}</td>
          <td class="col-eqp">
            <div class="paper-equip-wrap">
              <span class="paper-equip-pill ${r.typeGroup}">${this.escapeHtml(r.equipType)}</span>
              <span class="paper-equip-count">${this.escapeHtml(r.equipCount)}</span>
            </div>
          </td>
          <td class="col-req">
            <span class="paper-req-gear">${r.equipment ? this.escapeHtml(r.equipment) : '-'}</span>
            ${r.access ? `<span class="paper-req-access">(${this.escapeHtml(r.access)})</span>` : ''}
          </td>
          <td class="col-nte"><span class="paper-notes-text">${this.escapeHtml(r.notes || '-')}</span></td>
          <td class="col-mem">${memoHtml}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="a4-sheet-header">
        <div>
          <h2 class="a4-sheet-title">TDR 空調設備 作業チェックリスト</h2>
          <div class="a4-sheet-meta">
            抽出条件: ${this.escapeHtml(ctx.conditionLabel)}　／　出力日: ${dateStr}
          </div>
        </div>
        <table class="a4-sign-box">
          <tr><th>実施日</th><th>作業班 / 担当</th><th>完了確認</th></tr>
          <tr><td>　/　/</td><td></td><td>${checkMarkMode === 'sync' ? doneCount : '　'} / ${expRows.length} 件</td></tr>
        </table>
      </div>

      <div class="a4-summary-strip">
        <span>対象合計: ${roomSet.size}部屋 / ${expRows.length}機器 (計 ${totalUnits}台)</span>
        <span>${checkMarkMode === 'sync' ? `現在完了: ${doneCount}件 / 未着手: ${expRows.length - doneCount}件` : '□ チェック欄空欄モード（紙記入用）'}</span>
      </div>

      <table class="a4-print-table">
        <thead>
          <tr>
            <th class="col-chk">済</th>
            <th class="col-no">No</th>
            <th class="col-loc">階層 / 部屋名（メイン）</th>
            <th class="col-eqp">点検対象機器・台数</th>
            <th class="col-req">必要なもの / アクセス</th>
            <th class="col-nte">備考・特記事項</th>
            <th class="col-mem">確認メモ</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    `;
  }

  renderChecklistPrintPreview() {
    const src = document.getElementById('print-modal-source-select')?.value || 'checklist';
    const chkMode = document.getElementById('print-modal-check-select')?.value || 'blank';
    const html = this.buildChecklistPrintHtml(src, chkMode);

    const previewEl = document.getElementById('checklist-print-preview-sheet');
    if (previewEl) previewEl.innerHTML = html;

    const printArea = document.getElementById('checklist-print-area');
    if (printArea) printArea.innerHTML = `<div class="a4-portrait-sheet">${html}</div>`;
  }

  executeChecklistPrint() {
    this.renderChecklistPrintPreview();
    document.body.classList.add('printing-checklist');

    const cleanup = () => {
      document.body.classList.remove('printing-checklist');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);

    // 印刷ダイアログ起動
    setTimeout(() => {
      window.print();
      // iOS Safari等で afterprint が遅れるケースのフォールバック解除
      setTimeout(() => {
        document.body.classList.remove('printing-checklist');
      }, 3000);
    }, 80);
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

  // ================= 外部調査表(CSV) 一括変換インポートロジック =================
  openCSVImportModal() {
    const modal = document.getElementById('csv-import-modal');
    if (!modal) return;
    this.pendingCSVImportRecords = [];
    const box = document.getElementById('csv-import-preview-box');
    if (box) box.classList.add('hidden');
    const execBtn = document.getElementById('csv-import-exec-btn');
    if (execBtn) {
      execBtn.disabled = true;
      execBtn.textContent = '✅ 解析を実行してから追加登録できます';
    }
    modal.classList.remove('hidden');
  }

  closeCSVImportModal() {
    document.getElementById('csv-import-modal')?.classList.add('hidden');
  }

  handleCSVImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const buf = evt.target.result;
      let text = '';
      try {
        // まずUTF-8 (BOM付含む) として厳格デコードを試行し、失敗したらShift-JIS (Excel日本語版標準) で読む
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch (utfErr) {
        try {
          text = new TextDecoder('shift-jis').decode(buf);
        } catch (sjisErr) {
          text = new TextDecoder('utf-8').decode(buf);
        }
      }
      // 先頭BOM除去
      text = text.replace(/^\uFEFF/, '');
      const ta = document.getElementById('csv-import-textarea');
      if (ta) ta.value = text;
      this.previewExternalCSVImport();
    };
    reader.readAsArrayBuffer(file);
    e.target.value = '';
  }

  // RFC 4180準拠（セル内改行・ダブルクォート対応）CSVパーサー
  parseCSVTextRows(text) {
    const rows = [];
    let row = [];
    let cur = '';
    let inQuotes = false;
    const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          row.push(cur);
          cur = '';
        } else if (ch === '\n') {
          row.push(cur);
          rows.push(row);
          row = [];
          cur = '';
        } else {
          cur += ch;
        }
      }
    }
    if (cur.length > 0 || row.length > 0) {
      row.push(cur);
      rows.push(row);
    }
    return rows;
  }

  detectParkFromArea(areaName) {
    const a = String(areaName || '');
    const tdsAreas = [
      'メディテレーニアン', 'アメリカン', 'ポートディスカバリー', 'ロストリバー',
      'アラビアン', 'マーメイド', 'ミステリアス', 'ファンタジースプリングス'
    ];
    if (tdsAreas.some(k => a.includes(k))) return 'TDS';
    const tdlAreas = [
      'ワールドバザール', 'アドベンチャー', 'ウエスタン', 'クリッター',
      'ファンタジーランド', 'トゥーンタウン', 'トゥモロー'
    ];
    if (tdlAreas.some(k => a.includes(k))) return 'TDL';
    if (a.includes('ホテル') || a.includes('ミラコスタ') || a.includes('アンバサダー')) return 'HOTEL';
    return 'TDS';
  }

  // 外部調査表(CSV)をアプリ標準レコードへ変換
  parseExternalScheduleCSV(csvText, options = {}) {
    const rows = this.parseCSVTextRows(csvText);
    const parkOpt = options.park || 'AUTO';
    const tag = (options.tag !== undefined ? options.tag : '【Lic作成分】').trim();
    const skipDup = options.skipDup !== false;

    // 既存データの重複チェック用セット
    const existingKeys = new Set(
      (this.records || []).map(r =>
        this.normalizeSearchText(`${r.facility || ''}||${r.floor || ''}||${r.room || ''}`)
      )
    );

    const parsedRecords = [];
    let skippedDupCount = 0;

    let curArea = '';
    let curEngFac = '';
    let curFacility = '';
    let inTable = false;

    let curAcc1 = '';
    let curAcc2 = '';
    let curFloor = '';
    let routeStack = []; // [{ depth, label }]

    const nowBase = Date.now();

    for (let idx = 0; idx < rows.length; idx++) {
      const r = rows[idx];
      const c0 = (r[0] || '').trim();
      const c1 = (r[1] || '').trim();
      const c2 = (r[2] || '').trim();
      const c3Raw = r[3] || '';
      const c3 = c3Raw.trim();

      // 空行は施設テーブルを切らずにスキップ（インディ末尾などの分割対応）
      if (r.every(cell => !cell || !cell.trim())) {
        continue;
      }

      // 1. エリア行
      if (c1 === 'エリア') {
        curArea = c2;
        curEngFac = '';
        curFacility = '';
        inTable = false;
        curAcc1 = '';
        curAcc2 = '';
        curFloor = '';
        routeStack = [];
        continue;
      }

      // 2. 英語建物名行
      if (c1 === '名称（建物名）' || c1 === '名称(建物名)') {
        curEngFac = c2;
        continue;
      }

      // 3. テーブルヘッダー行
      if (c0 === 'アクセス' && c3 === '室名') {
        inTable = true;
        curAcc1 = '';
        curAcc2 = '';
        curFloor = '';
        routeStack = [];
        continue;
      }

      // 4. 日本語施設名行（テーブル開始前）
      if (!inTable) {
        if (c2) {
          curFacility = c2.replace(/\u3000+/g, ' ').trim();
        }
        continue;
      }

      // === テーブル内の実データ行 ===
      if (c0) {
        if (c0 !== curAcc1) {
          curAcc1 = c0;
          if (!c1) curAcc2 = '';
        }
      }
      if (c1) {
        curAcc2 = c1;
      }
      if (c2) {
        curFloor = c2;
      }

      // 室名インデント階層解析
      const firstLine = c3Raw.split(/\r?\n/)[0] || '';
      let leadingSp = 0;
      for (const ch of firstLine) {
        if (ch === ' ' || ch === '\u3000' || ch === '\t') leadingSp++;
        else break;
      }
      const trimmedFirst = firstLine.trim();
      const hasArrow = trimmedFirst.startsWith('→');
      const depth = hasArrow ? (1 + leadingSp) : (leadingSp > 0 ? 1 + leadingSp : 0);

      // 表示用の綺麗な部屋名（全行を結合し先頭矢印や余分空白を除去）
      const cleanRoomLines = c3Raw.split(/\r?\n/)
        .map(line => line.trim().replace(/^→\s*/, '').trim())
        .filter(Boolean);
      const cleanRoomName = cleanRoomLines.join(' ').replace(/\s+/g, ' ').trim();

      const rawSpec = (r[4] || '').trim();
      const rawCount = (r[5] || '').trim();
      const rawClean = (r[6] || '').trim();
      const rawNote = (r[7] || '').trim();

      // 親スタック整理: 自分以上の深さをpop
      while (routeStack.length > 0 && routeStack[routeStack.length - 1].depth >= depth) {
        routeStack.pop();
      }

      const parentPaths = routeStack.map(p => p.label);

      // 仕様も台数も備考も空の中継行 → 親経路ノードとしてスタックへ登録しスキップ
      const hasUnitInfo = Boolean(rawSpec || rawCount);
      if (!hasUnitInfo) {
        if (cleanRoomName && !cleanRoomName.includes('階段で上へ') && !cleanRoomName.includes('室内階段へ')) {
          routeStack.push({ depth, label: cleanRoomName });
        }
        continue;
      }

      // 自分も子を持つ可能性があるので親スタックに積む（もし次がもっと深いインデントなら親になる）
      if (cleanRoomName) {
        routeStack.push({ depth, label: cleanRoomName });
      }

      // 仕様・台数の解析（ユーザー確定仕様）
      const specLines = rawSpec.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const countLines = rawCount.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

      const pacSubtypes = { cassette: 0, floor: 0, ceiling: 0, wall: 0, duct: 0, other: 0, unknown: 0 };
      let hexCount = 0;
      let fcuCount = 0;
      const specNoteExtras = [];

      specLines.forEach((sp, si) => {
        const cntRaw = countLines[si] !== undefined ? countLines[si] : (countLines[0] || '0');
        const num = parseInt(cntRaw, 10) || 0;

        if (sp.includes('なし')) {
          specNoteExtras.push('仕様・台数なし');
        } else if (sp.includes('全熱')) {
          hexCount += num;
        } else if (sp.includes('ﾌｧﾝｺｲﾙ') || sp.includes('ファンコイル')) {
          fcuCount += num;
        } else if (sp.includes('壁掛')) {
          pacSubtypes.wall += num;
        } else if (sp.includes('外床置')) {
          pacSubtypes.floor += num;
          specNoteExtras.push('外床置き');
        } else if (sp.includes('床置')) {
          pacSubtypes.floor += num;
        } else if (sp.includes('隠蔽') || sp.includes('天中')) {
          pacSubtypes.duct += num;
        } else if (sp.includes('天井')) {
          pacSubtypes.unknown += num;
          specNoteExtras.push('元仕様:天井');
        } else if (sp.includes('空調')) {
          pacSubtypes.unknown += num;
          specNoteExtras.push('元仕様:空調');
        } else if (num > 0) {
          pacSubtypes.unknown += num;
          specNoteExtras.push(`元仕様:${sp}`);
        }
      });

      const pacCount = pacSubtypes.cassette + pacSubtypes.floor + pacSubtypes.ceiling +
                       pacSubtypes.wall + pacSubtypes.duct + pacSubtypes.other + pacSubtypes.unknown;
      const totalUnits = pacCount + hexCount + fcuCount;

      // 必要なもの（脚立など）と備考の振り分け
      const gearList = [];
      const extraCleanNote = [rawClean, rawNote].filter(Boolean).map(t => t.replace(/\r?\n/g, ' '));
      const combinedNoteText = extraCleanNote.join(' / ');

      const ladderMatch = combinedNoteText.match(/([46789]尺(?:脚立|必須)?)/g);
      if (ladderMatch) {
        ladderMatch.forEach(m => {
          const cleanM = m.replace(/必須$/, '脚立');
          if (!gearList.includes(cleanM)) gearList.push(cleanM);
        });
      }

      // 備考構築（先頭に【Lic作成分】識別タグ）
      const noteParts = [];
      if (tag) noteParts.push(tag);
      if (specNoteExtras.length > 0) noteParts.push(`(${Array.from(new Set(specNoteExtras)).join(', ')})`);
      if (combinedNoteText) noteParts.push(combinedNoteText);
      const finalNotes = noteParts.join(' ');

      // アクセス方法構築
      const accessParts = [curAcc1, curAcc2].filter(Boolean);
      if (parentPaths.length > 0) {
        accessParts.push(`経由: ${parentPaths.join(' ＞ ')}`);
      }
      const finalAccess = accessParts.join(' / ');

      const finalFacility = curFacility || curEngFac || '(施設未設定)';
      const finalPark = parkOpt === 'AUTO' ? this.detectParkFromArea(curArea) : parkOpt;
      const finalRoom = cleanRoomName || '(部屋名未設定)';

      // 重複チェック
      const dupKey = this.normalizeSearchText(`${finalFacility}||${curFloor}||${finalRoom}`);
      if (skipDup && existingKeys.has(dupKey)) {
        skippedDupCount++;
        continue;
      }
      existingKeys.add(dupKey);

      const summaryParts = [];
      if (pacSubtypes.wall > 0) summaryParts.push(`PAC壁掛:${pacSubtypes.wall}`);
      if (pacSubtypes.floor > 0) summaryParts.push(`PAC床置:${pacSubtypes.floor}`);
      if (pacSubtypes.duct > 0) summaryParts.push(`PACダクト:${pacSubtypes.duct}`);
      if (pacSubtypes.unknown > 0) summaryParts.push(`PAC確認中:${pacSubtypes.unknown}`);
      if (hexCount > 0) summaryParts.push(`全熱:${hexCount}`);
      if (fcuCount > 0) summaryParts.push(`FCU:${fcuCount}`);

      const recTime = new Date(nowBase + parsedRecords.length * 1000).toISOString();

      parsedRecords.push({
        id: `lic_${nowBase}_${parsedRecords.length + 1}`,
        resort: 'TDR',
        park: finalPark,
        area: curArea,
        facility: finalFacility,
        floor: curFloor,
        room: finalRoom,
        fullPath: `[${finalPark}] ${curArea} / ${finalFacility} / ${curFloor || '-'} / ${finalRoom}`,
        pacCount,
        pacSubtypes,
        hexCount,
        fcuCount,
        totalUnits,
        otherEquipment: '',
        equipSummary: summaryParts.join(' / ') || 'メモ確認用',
        equipment: gearList.join(' '),
        access: finalAccess,
        filterSpec: '',
        machineNo: '',
        notes: finalNotes,
        photos: { entrance: [], room: [], equipment: [] },
        completed: false,
        completedEquip: {},
        completedAt: null,
        createdAt: recTime,
        updatedAt: recTime
      });
    }

    return { records: parsedRecords, skippedDupCount };
  }

  previewExternalCSVImport() {
    const csvText = document.getElementById('csv-import-textarea')?.value || '';
    const box = document.getElementById('csv-import-preview-box');
    const execBtn = document.getElementById('csv-import-exec-btn');
    if (!box || !execBtn) return;

    if (!csvText.trim()) {
      this.showToast('CSVデータを貼り付けるか、ファイルを選択してください', true);
      return;
    }

    const parkOpt = document.getElementById('csv-import-park')?.value || 'AUTO';
    const tagVal = document.getElementById('csv-import-tag')?.value ?? '【Lic作成分】';
    const skipDup = document.getElementById('csv-import-skip-dup')?.checked ?? true;

    const result = this.parseExternalScheduleCSV(csvText, { park: parkOpt, tag: tagVal, skipDup });
    this.pendingCSVImportRecords = result.records;

    const recs = result.records;
    const facCounts = new Map();
    let totalUnits = 0, wall = 0, floor = 0, duct = 0, unk = 0, hex = 0, fcu = 0;

    recs.forEach(r => {
      facCounts.set(r.facility, (facCounts.get(r.facility) || 0) + 1);
      totalUnits += r.totalUnits;
      wall += r.pacSubtypes.wall;
      floor += r.pacSubtypes.floor;
      duct += r.pacSubtypes.duct;
      unk += r.pacSubtypes.unknown;
      hex += r.hexCount;
      fcu += r.fcuCount;
    });

    const facListHtml = Array.from(facCounts.entries())
      .map(([fn, c]) => `<div style="font-size:11.5px; color:#cbd5e1;">・${this.escapeHtml(fn)} <strong>(${c}室)</strong></div>`)
      .join('');

    const sampleHtml = recs.slice(0, 3).map(r => `
      <div style="font-size:11px; padding:4px 6px; margin-top:4px; background:rgba(30,41,59,0.8); border-radius:4px; border-left:3px solid #10b981;">
        <strong>${this.escapeHtml(r.facility)} / ${this.escapeHtml(r.floor)} ${this.escapeHtml(r.room)}</strong><br>
        <span style="color:#38bdf8;">${this.escapeHtml(r.equipSummary)}</span>
        ${r.access ? `<br><span style="color:#94a3b8;">🚪 ${this.escapeHtml(r.access)}</span>` : ''}
        ${r.notes ? `<br><span style="color:#fbbf24;">📝 ${this.escapeHtml(r.notes)}</span>` : ''}
      </div>
    `).join('');

    box.innerHTML = `
      <div style="font-size:13px; font-weight:700; color:#38bdf8; margin-bottom:6px;">
        📊 解析結果: ${facCounts.size}施設 / ${recs.length}部屋 (計 ${totalUnits}台)
      </div>
      ${result.skippedDupCount > 0 ? `<div style="font-size:11px; color:#fbbf24; margin-bottom:6px;">※ 既存データと重複するため ${result.skippedDupCount} 件を自動スキップしました</div>` : ''}
      <div style="font-size:11px; color:#e2e8f0; margin-bottom:6px;">
        内訳: PAC確認中(天井・空調)=${unk}台 / 隠蔽ダクト(天中・隠蔽)=${duct}台 / 壁掛=${wall}台 / 床置=${floor}台 / 全熱=${hex}台 / FCU=${fcu}台
      </div>
      <div style="max-height:110px; overflow-y:auto; margin-bottom:8px; padding:4px; background:rgba(0,0,0,0.2); border-radius:4px;">
        ${facListHtml || '<span class="text-xs text-muted">追加対象のデータが見つかりませんでした</span>'}
      </div>
      ${sampleHtml ? `<div style="font-size:11px; color:#94a3b8; font-weight:700;">変換サンプル（先頭3件）:</div>${sampleHtml}` : ''}
    `;
    box.classList.remove('hidden');

    if (recs.length > 0) {
      execBtn.disabled = false;
      execBtn.textContent = `✅ 既存(${this.records.length}件)を残して ${recs.length}件を追加登録する`;
    } else {
      execBtn.disabled = true;
      execBtn.textContent = '追加できるデータがありません';
    }
  }

  async executeExternalCSVImport() {
    const recs = this.pendingCSVImportRecords || [];
    if (recs.length === 0) {
      this.showToast('追加するデータがありません', true);
      return;
    }

    if (!confirm(`既存の ${this.records.length} 件はそのまま保持し、新たに ${recs.length} 件をリストへ追加登録しますか？`)) {
      return;
    }

    try {
      for (const item of recs) {
        await this.saveRecord(item);
      }
      await this.loadRecords();
      this.updateParkAreas();
      this.renderChecklistView();
      this.renderSpreadsheetPreview();
      this.closeCSVImportModal();
      this.showToast(`🎉 新たに ${recs.length} 件を追加登録しました！（合計 ${this.records.length} 件）`);
    } catch (err) {
      console.error(err);
      this.showToast('一括追加の保存中にエラーが発生しました', true);
    }
  }

  // ================= 8.5. 作業チェックリスト (Checklist) ロジック =================
  // レコードに存在する機器種別の一覧を取得
  getRecordEquipList(r) {
    if (!r) return [];
    const list = [];
    const subs = r.pacSubtypes || {};
    if (subs.cassette > 0) list.push({ key: 'cassette', label: '天カセ', count: subs.cassette, type: 'pac' });
    if (subs.floor > 0) list.push({ key: 'floor', label: '床置', count: subs.floor, type: 'pac' });
    if (subs.ceiling > 0) list.push({ key: 'ceiling', label: '天吊', count: subs.ceiling, type: 'pac' });
    if (subs.wall > 0) list.push({ key: 'wall', label: '壁掛', count: subs.wall, type: 'pac' });
    if (subs.duct > 0) list.push({ key: 'duct', label: '隠蔽ダクト', count: subs.duct, type: 'pac' });
    if (subs.other > 0) list.push({ key: 'other_pac', label: '他PAC', count: subs.other, type: 'pac' });
    if (subs.unknown > 0) list.push({ key: 'unknown_pac', label: 'PAC(確認中)', count: subs.unknown, type: 'pac' });
    
    // 旧データ互換: subtypes がなく pacCount だけがある場合
    const subTotal = (subs.cassette || 0) + (subs.floor || 0) + (subs.ceiling || 0) + (subs.wall || 0) + (subs.duct || 0) + (subs.other || 0) + (subs.unknown || 0);
    if ((r.pacCount || 0) > subTotal) {
      list.push({ key: 'pac', label: 'PAC', count: (r.pacCount || 0) - subTotal, type: 'pac' });
    }

    if (r.hexCount > 0) list.push({ key: 'hex', label: '全熱交換器', count: r.hexCount, type: 'hex' });
    if (r.fcuCount > 0) list.push({ key: 'fcu', label: 'FCU', count: r.fcuCount, type: 'fcu' });
    if (r.otherEquipment && r.otherEquipment.trim()) {
      list.push({ key: 'other', label: r.otherEquipment.trim(), count: 1, type: 'other' });
    }

    return list;
  }

  // 機器ごとの完了状態（100%下位互換性保持）
  isEquipCompleted(r, equipKey) {
    if (!r) return false;
    if (r.completedEquip && typeof r.completedEquip[equipKey] === 'boolean') {
      return r.completedEquip[equipKey];
    }
    // completedEquip 未定義時はレコードの completed を適用（過去データがそのまま活きる）
    return !!r.completed;
  }

  // レコードの作業完了サマリー（全体・一部・未着手）
  getRecordCompletionSummary(r) {
    const equips = this.getRecordEquipList(r);
    if (equips.length === 0) {
      const done = !!r.completed;
      return {
        status: done ? 'completed' : 'pending',
        doneCount: done ? 1 : 0,
        totalCount: 1,
        isAllDone: done,
        isAnyDone: done,
        equips: []
      };
    }

    let doneCount = 0;
    const equipStates = equips.map(eq => {
      const isDone = this.isEquipCompleted(r, eq.key);
      if (isDone) doneCount++;
      return { ...eq, isDone };
    });

    const isAllDone = (doneCount === equips.length);
    const isAnyDone = (doneCount > 0);
    let status = 'pending';
    if (isAllDone) status = 'completed';
    else if (isAnyDone) status = 'partial';

    return {
      status, // 'completed' | 'partial' | 'pending'
      doneCount,
      totalCount: equips.length,
      isAllDone,
      isAnyDone,
      equips: equipStates
    };
  }

  // 機種フィルタ表記・正規化ヘルパー
  getUnitTypeLabel(key) {
    const typeNames = {
      cassette: 'PAC (天カセ)', floor: 'PAC (床置)', ceiling: 'PAC (天吊)', wall: 'PAC (壁掛)',
      duct: 'PAC (隠蔽ダクト)', other_pac: 'PAC (他)', unknown_pac: 'PAC (確認中)',
      pac_any: 'PAC全種', hex: '全熱交換器', fcu: 'FCU', other: 'その他機器'
    };
    return typeNames[key] || key;
  }

  normalizeUnitFilterArray(unitFilter) {
    if (!unitFilter) return [];
    if (Array.isArray(unitFilter)) return unitFilter.filter(Boolean);
    return String(unitFilter).trim() ? [String(unitFilter).trim()] : [];
  }

  equipKeyMatchesFilterArray(equipKey, filterArr) {
    if (!filterArr || filterArr.length === 0) return true;
    if (!equipKey) return false;
    if (filterArr.includes(equipKey)) return true;
    if (filterArr.includes('pac_any')) {
      return ['cassette', 'floor', 'ceiling', 'wall', 'duct', 'other_pac', 'unknown_pac', 'pac'].includes(equipKey);
    }
    return false;
  }

  recordMatchesUnitTypes(r, filterArr) {
    if (!filterArr || filterArr.length === 0) return true;
    const equips = this.getRecordEquipList(r);
    return equips.some(eq => this.equipKeyMatchesFilterArray(eq.key, filterArr));
  }

  // 現在の絞り込み機種（単一・複数両対応）を対象とした完了判定
  isRecordTargetCompleted(r, filterUnitType) {
    if (!r) return false;
    const types = this.normalizeUnitFilterArray(filterUnitType);
    if (types.length === 0) {
      return !!r.completed;
    }
    const equips = this.getRecordEquipList(r);
    const matching = equips.filter(e => this.equipKeyMatchesFilterArray(e.key, types));
    if (matching.length === 0) return !!r.completed;
    return matching.every(e => this.isEquipCompleted(r, e.key));
  }

  // レコード全体の completed と completedAt を同期
  syncRecordCompletion(r) {
    const comp = this.getRecordCompletionSummary(r);
    r.completed = comp.isAllDone;
    if (comp.isAllDone) {
      if (!r.completedAt) r.completedAt = new Date().toISOString();
    } else if (!comp.isAnyDone) {
      r.completedAt = null;
    }
  }

  // 作業チェックリストの複数選択ボタン・チップを更新
  updateCheckFilterOptions() {
    this.renderCheckFilterButtonsAndChips();
  }

  renderCheckFilterButtonsAndChips() {
    const mf = this.checkMultiFilters || { park: [], area: [], facility: [], floor: [], unitType: [], equipment: [] };
    const configs = [
      { key: 'park', id: 'check-filter-btn-park', icon: '🏰', def: '全パーク', labelName: 'パーク' },
      { key: 'area', id: 'check-filter-btn-area', icon: '🗺️', def: '全エリア (複数可)', labelName: 'エリア' },
      { key: 'facility', id: 'check-filter-btn-facility', icon: '🏢', def: '全施設 (複数可)', labelName: '施設' },
      { key: 'floor', id: 'check-filter-btn-floor', icon: '📶', def: '全階層 (複数可)', labelName: '階層' },
      { key: 'unitType', id: 'check-filter-btn-unitType', icon: '❄️', def: '全空調機種 (複数可)', labelName: '機種' },
      { key: 'equipment', id: 'check-filter-btn-equipment', icon: '🪜', def: '全機材・脚立 (複数可)', labelName: '機材' }
    ];

    configs.forEach(c => {
      const btn = document.getElementById(c.id);
      if (!btn) return;
      const arr = mf[c.key] || [];
      btn.classList.toggle('has-selection', arr.length > 0);
      const labelEl = btn.querySelector('.mf-label');
      if (labelEl) {
        if (arr.length === 0) {
          labelEl.textContent = `${c.icon} ${c.def}`;
        } else if (arr.length === 1) {
          let disp = c.key === 'unitType' ? this.getUnitTypeLabel(arr[0]) : arr[0];
          if (disp === '__SELF_ONLY__') disp = '直接作成のみ';
          labelEl.textContent = `${c.icon} ${disp}`;
        } else {
          labelEl.textContent = `${c.icon} ${c.labelName}: ${arr.length}件選択`;
        }
      }
    });

    // 選択中チップバー描画
    const chipsBar = document.getElementById('check-active-filter-chips');
    if (!chipsBar) return;
    const allChips = [];
    configs.forEach(c => {
      (mf[c.key] || []).forEach(val => {
        let disp = c.key === 'unitType' ? this.getUnitTypeLabel(val) : val;
        if (disp === '__SELF_ONLY__') disp = '直接作成のみ';
        allChips.push(`
          <button type="button" class="active-filter-chip" title="タップで解除" onclick="app.removeCheckMultiFilterChip('${c.key}', '${this.escapeHtml(val).replace(/'/g, "\\'")}')">
            <span>${c.icon} ${this.escapeHtml(disp)}</span>
            <span class="afc-close">✕</span>
          </button>
        `);
      });
    });

    if (allChips.length > 0) {
      chipsBar.innerHTML = allChips.join('');
      chipsBar.classList.remove('hidden');
    } else {
      chipsBar.innerHTML = '';
      chipsBar.classList.add('hidden');
    }
  }

  removeCheckMultiFilterChip(key, value) {
    if (!this.checkMultiFilters || !this.checkMultiFilters[key]) return;
    this.checkMultiFilters[key] = this.checkMultiFilters[key].filter(v => v !== value);
    this.renderCheckFilterButtonsAndChips();
    this.renderChecklistView();
  }

  // 複数選択モーダルを開く
  openCheckMultiFilter(key) {
    this.activeMultiFilterKey = key;
    this.tempMultiFilterSelected = [...(this.checkMultiFilters[key] || [])];

    const titles = {
      park: '🏰 パークを複数選択',
      area: '🗺️ エリアを複数選択',
      facility: '🏢 施設・アトラクションを複数選択',
      floor: '📶 階層を複数選択',
      unitType: '❄️ 空調機種を複数選択',
      equipment: '🪜 必要な機材・アクセスを複数選択'
    };
    const titleEl = document.getElementById('multi-filter-modal-title');
    if (titleEl) titleEl.textContent = titles[key] || '複数選択';

    const searchInput = document.getElementById('multi-filter-search-input');
    if (searchInput) searchInput.value = '';
    document.getElementById('multi-filter-search-clear')?.classList.add('hidden');

    this.renderMultiFilterOptions();
    document.getElementById('check-multi-filter-modal')?.classList.remove('hidden');
  }

  closeCheckMultiFilter() {
    document.getElementById('check-multi-filter-modal')?.classList.add('hidden');
    this.activeMultiFilterKey = null;
  }

  getMultiFilterOptionItems(key) {
    const recs = this.records || [];
    const mf = this.checkMultiFilters || {};
    const items = [];

    if (key === 'park') {
      const labels = { TDS: 'TDS (東京ディズニーシー)', TDL: 'TDL (東京ディズニーランド)', HOTEL: 'ディズニーホテル', OTHER: 'その他' };
      ['TDS', 'TDL', 'HOTEL', 'OTHER'].forEach(pk => {
        const cnt = recs.filter(r => r.park === pk).length;
        if (cnt > 0 || pk === 'TDS' || pk === 'TDL') {
          items.push({ value: pk, label: labels[pk] || pk, sub: '', count: cnt });
        }
      });
      return items;
    }

    if (key === 'area') {
      const areaMap = new Map();
      recs.forEach(r => {
        if (!r.area) return;
        if (mf.park.length > 0 && !mf.park.includes(r.park)) return;
        if (!areaMap.has(r.area)) areaMap.set(r.area, { park: r.park, count: 0 });
        areaMap.get(r.area).count++;
      });
      // パーク絞込で0になる場合のフォールバック（全レコード）
      if (areaMap.size === 0) {
        recs.forEach(r => {
          if (!r.area) return;
          if (!areaMap.has(r.area)) areaMap.set(r.area, { park: r.park, count: 0 });
          areaMap.get(r.area).count++;
        });
      }
      return Array.from(areaMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0], 'ja'))
        .map(([val, info]) => ({ value: val, label: val, sub: info.park, count: info.count }));
    }

    if (key === 'facility') {
      const facMap = new Map();
      recs.forEach(r => {
        if (!r.facility) return;
        if (!facMap.has(r.facility)) {
          facMap.set(r.facility, { park: r.park, area: r.area || '', count: 0, inSelectedArea: true });
        }
        const entry = facMap.get(r.facility);
        entry.count++;
      });
      return Array.from(facMap.entries())
        .map(([val, info]) => {
          const isAreaMatch = mf.area.length === 0 || mf.area.includes(info.area);
          return {
            value: val,
            label: val,
            sub: `[${info.park}] ${info.area}`,
            count: info.count,
            _priority: isAreaMatch ? 0 : 1
          };
        })
        .sort((a, b) => a._priority - b._priority || a.label.localeCompare(b.label, 'ja'));
    }

    if (key === 'floor') {
      const flMap = new Map();
      recs.forEach(r => {
        const fl = (r.floor || '').trim();
        if (!fl) return;
        flMap.set(fl, (flMap.get(fl) || 0) + 1);
      });
      return Array.from(flMap.entries())
        .sort((a, b) => this.parseFloorOrder(a[0]) - this.parseFloorOrder(b[0]) || a[0].localeCompare(b[0], 'ja'))
        .map(([val, count]) => ({ value: val, label: val, sub: '', count }));
    }

    if (key === 'unitType') {
      const unitDefs = [
        { value: 'cassette', label: 'PAC (天カセ)' },
        { value: 'floor', label: 'PAC (床置き)' },
        { value: 'ceiling', label: 'PAC (天吊り)' },
        { value: 'wall', label: 'PAC (壁掛け)' },
        { value: 'duct', label: 'PAC (隠蔽ダクト)' },
        { value: 'other_pac', label: 'PAC (その他)' },
        { value: 'unknown_pac', label: 'PAC (種別確認中)' },
        { value: 'pac_any', label: 'PAC (全形式まとめて)' },
        { value: 'hex', label: '全熱交換器 (HEX)' },
        { value: 'fcu', label: 'ファンコイル (FCU)' },
        { value: 'other', label: 'その他機器' }
      ];
      return unitDefs.map(d => ({
        value: d.value,
        label: d.label,
        sub: '',
        count: recs.filter(r => this.recordMatchesUnitTypes(r, [d.value])).length
      }));
    }

    if (key === 'equipment') {
      const presets = ['9尺', '8尺', '7尺', '6尺', '4尺', 'フィルター', 'バックステージ', 'オンステージ', '【Lic作成分】', '__SELF_ONLY__'];
      return presets.map(kw => {
        let label = kw;
        let sub = '部分一致キーワード';
        let count = 0;
        if (kw === '9尺' || kw === '8尺' || kw === '7尺' || kw === '6尺' || kw === '4尺') {
          label = `${kw}脚立`;
          count = recs.filter(r => `${r.equipment || ''} ${r.access || ''} ${r.notes || ''}`.includes(kw)).length;
        } else if (kw === '__SELF_ONLY__') {
          label = '📱 直接作成データのみ (Lic除外)';
          sub = '作成元フィルタ';
          count = recs.filter(r => !(r.notes || '').includes('【Lic作成分】')).length;
        } else if (kw === '【Lic作成分】') {
          label = '🏷️ 【Lic作成分】のみ';
          sub = '外部CSV取込データ';
          count = recs.filter(r => (r.notes || '').includes('【Lic作成分】')).length;
        } else {
          count = recs.filter(r => `${r.equipment || ''} ${r.access || ''} ${r.notes || ''}`.includes(kw)).length;
        }
        return { value: kw, label, sub, count };
      });
    }

    return items;
  }

  renderMultiFilterOptions() {
    const key = this.activeMultiFilterKey;
    const container = document.getElementById('multi-filter-options-list');
    const applyBtn = document.getElementById('apply-multi-filter-btn');
    if (!key || !container) return;

    const query = (document.getElementById('multi-filter-search-input')?.value || '').trim();
    const allItems = this.getMultiFilterOptionItems(key);
    const visibleItems = query
      ? allItems.filter(it => this.matchesSearchQuery(`${it.label} ${it.sub}`, query))
      : allItems;

    if (visibleItems.length === 0) {
      container.innerHTML = `<div style="text-align:center; padding:24px; color:#94a3b8; font-size:13px;">一致する項目がありません</div>`;
    } else {
      container.innerHTML = visibleItems.map(it => {
        const isSelected = this.tempMultiFilterSelected.includes(it.value);
        const safeVal = this.escapeHtml(it.value).replace(/'/g, "\\'");
        return `
          <div class="mf-option-item ${isSelected ? 'is-selected' : ''}" onclick="app.toggleTempMultiFilterOption('${safeVal}')">
            <div class="mf-option-left">
              <span class="mf-option-check">${isSelected ? '✔' : ''}</span>
              <div class="mf-option-texts">
                <span class="mf-option-name">${this.escapeHtml(it.label)}</span>
                ${it.sub ? `<span class="mf-option-sub">${this.escapeHtml(it.sub)}</span>` : ''}
              </div>
            </div>
            <span class="mf-option-count">${it.count}件</span>
          </div>
        `;
      }).join('');
    }

    if (applyBtn) {
      const cnt = this.tempMultiFilterSelected.length;
      applyBtn.textContent = cnt > 0
        ? `✅ 選択した ${cnt} 件の条件で絞り込む`
        : '✅ すべて選択解除して全表示する';
    }
  }

  toggleTempMultiFilterOption(val) {
    if (this.tempMultiFilterSelected.includes(val)) {
      this.tempMultiFilterSelected = this.tempMultiFilterSelected.filter(v => v !== val);
    } else {
      this.tempMultiFilterSelected.push(val);
    }
    this.renderMultiFilterOptions();
  }

  selectAllMultiFilterOptions(selectAll) {
    const key = this.activeMultiFilterKey;
    if (!key) return;
    if (!selectAll) {
      this.tempMultiFilterSelected = [];
    } else {
      const query = (document.getElementById('multi-filter-search-input')?.value || '').trim();
      const allItems = this.getMultiFilterOptionItems(key);
      const visible = query
        ? allItems.filter(it => this.matchesSearchQuery(`${it.label} ${it.sub}`, query))
        : allItems;
      const merged = new Set(this.tempMultiFilterSelected);
      visible.forEach(it => merged.add(it.value));
      this.tempMultiFilterSelected = Array.from(merged);
    }
    this.renderMultiFilterOptions();
  }

  applyCheckMultiFilter() {
    const key = this.activeMultiFilterKey;
    if (key) {
      this.checkMultiFilters[key] = [...this.tempMultiFilterSelected];
    }
    this.closeCheckMultiFilter();
    this.renderCheckFilterButtonsAndChips();
    this.renderChecklistView();
  }

  // 作業チェック用フィルタ＆ソート済みレコード配列取得（複数選択 OR 条件対応）
  getFilteredChecklistRecords() {
    let list = [...this.records];

    const statusFilter = this.checkStatusFilter; // 'all' | 'pending' | 'completed'
    const searchInputVal = document.getElementById('check-search-input')?.value || '';
    const mf = this.checkMultiFilters || { park: [], area: [], facility: [], floor: [], unitType: [], equipment: [] };
    const filterUnitTypes = mf.unitType || [];

    list = list.filter(r => {
      if (!r) return false;

      // パーク・エリア・施設・階層（カテゴリ内は複数選択OR一致、カテゴリ間はAND）
      if (mf.park.length > 0 && !mf.park.includes(r.park)) return false;
      if (mf.area.length > 0 && !mf.area.includes(r.area)) return false;
      if (mf.facility.length > 0 && !mf.facility.includes(r.facility)) return false;
      if (mf.floor.length > 0 && !mf.floor.includes(r.floor || '')) return false;

      // 空調機種での複数選択絞り込み
      if (filterUnitTypes.length > 0 && !this.recordMatchesUnitTypes(r, filterUnitTypes)) return false;

      // 作業ステータス絞り込み (選択機種がある場合は対象機器群の完了状態で判定)
      if (statusFilter !== 'all') {
        const isDone = this.isRecordTargetCompleted(r, filterUnitTypes);
        if (statusFilter === 'pending' && isDone) return false;
        if (statusFilter === 'completed' && !isDone) return false;
      }

      // 機材・脚立・アクセス・作成元タグ（複数選択OR）
      if (mf.equipment.length > 0) {
        const combined = `${r.equipment || ''} ${r.access || ''} ${r.notes || ''}`;
        const matched = mf.equipment.some(kw => {
          if (kw === '__SELF_ONLY__') return !(r.notes || '').includes('【Lic作成分】');
          return combined.includes(kw);
        });
        if (!matched) return false;
      }

      // 高度なあいまい・部分一致検索 (ひらがな/カタカナ相互一致、全半角正規化、複数ワードAND一致対応)
      if (searchInputVal.trim()) {
        const searchTarget = this.buildRecordSearchText(r);
        if (!this.matchesSearchQuery(searchTarget, searchInputVal)) return false;
      }

      return true;
    });

    // 並べ替え
    const sortOrder = document.getElementById('check-sort-order')?.value || 'hierarchy';
    const parkRank = { TDS: 1, TDL: 2, HOTEL: 3, OTHER: 4 };

    list.sort((a, b) => {
      if (sortOrder === 'pending-first') {
        const compA = this.isRecordTargetCompleted(a, filterUnitTypes) ? 1 : 0;
        const compB = this.isRecordTargetCompleted(b, filterUnitTypes) ? 1 : 0;
        if (compA !== compB) return compA - compB; // 未着手(0)が先
      } else if (sortOrder === 'completed-first') {
        const compA = this.isRecordTargetCompleted(a, filterUnitTypes) ? 1 : 0;
        const compB = this.isRecordTargetCompleted(b, filterUnitTypes) ? 1 : 0;
        if (compA !== compB) return compB - compA; // 完了(1)が先
      } else if (sortOrder === 'date-desc') {
        return new Date(b.createdAt) - new Date(a.createdAt);
      } else if (sortOrder === 'facility-asc') {
        const facCmp = (a.facility || '').localeCompare(b.facility || '', 'ja');
        if (facCmp !== 0) return facCmp;
        const flCmp = this.parseFloorOrder(a.floor) - this.parseFloorOrder(b.floor);
        if (flCmp !== 0) return flCmp;
        return (a.room || '').localeCompare(b.room || '', 'ja');
      } else if (sortOrder === 'floor-asc') {
        const flCmp = this.parseFloorOrder(a.floor) - this.parseFloorOrder(b.floor);
        if (flCmp !== 0) return flCmp;
        const facCmp = (a.facility || '').localeCompare(b.facility || '', 'ja');
        if (facCmp !== 0) return facCmp;
        return (a.room || '').localeCompare(b.room || '', 'ja');
      }

      // デフォルト: hierarchy (巡回順: パーク ＞ エリア ＞ 施設 ＞ 階層 ＞ 部屋)
      const pa = parkRank[a.park] || 9;
      const pb = parkRank[b.park] || 9;
      if (pa !== pb) return pa - pb;
      const areaCmp = (a.area || '').localeCompare(b.area || '', 'ja');
      if (areaCmp !== 0) return areaCmp;
      const facCmp = (a.facility || '').localeCompare(b.facility || '', 'ja');
      if (facCmp !== 0) return facCmp;
      const flCmp = this.parseFloorOrder(a.floor) - this.parseFloorOrder(b.floor);
      if (flCmp !== 0) return flCmp;
      return (a.room || '').localeCompare(b.room || '', 'ja');
    });

    return list;
  }

  // 作業チェックリスト画面のレンダリング
  renderChecklistView() {
    this.renderCheckFilterButtonsAndChips();

    const container = document.getElementById('check-list-container');
    const emptyState = document.getElementById('check-empty-state');
    const countText = document.getElementById('check-list-count-text');
    const percentBadge = document.getElementById('check-overall-percent-badge');
    const progressFill = document.getElementById('check-progress-bar-fill');
    const progressCountText = document.getElementById('check-progress-count-text');
    const filteredProgressText = document.getElementById('check-filtered-progress-text');

    const totalAll = (this.records || []).length;
    const completedAll = (this.records || []).filter(r => r && r.completed).length;
    const partialAll = (this.records || []).filter(r => {
      const c = this.getRecordCompletionSummary(r);
      return c.status === 'partial';
    }).length;
    const pendingAll = totalAll - completedAll;
    const percentAll = totalAll > 0 ? Math.round((completedAll / totalAll) * 100) : 0;

    // フィルタ適用（デフォルトでは全件表示、複数選択・部分一致対応）
    const filterUnitTypes = this.checkMultiFilters?.unitType || [];
    const filtered = this.getFilteredChecklistRecords();
    const completedFiltered = filtered.filter(r => this.isRecordTargetCompleted(r, filterUnitTypes)).length;
    const pendingFiltered = filtered.length - completedFiltered;

    // ステータスタブの件数バッジ更新
    const countAllEl = document.getElementById('status-count-all');
    const countPendingEl = document.getElementById('status-count-pending');
    const countCompletedEl = document.getElementById('status-count-completed');
    if (countAllEl) countAllEl.textContent = totalAll;
    if (countPendingEl) countPendingEl.textContent = pendingAll;
    if (countCompletedEl) countCompletedEl.textContent = completedAll;

    // 全体進捗バー更新
    if (percentBadge) percentBadge.textContent = `${percentAll}% 完了`;
    if (progressFill) progressFill.style.width = `${percentAll}%`;
    if (progressCountText) {
      const partialMsg = partialAll > 0 ? ` (一部完了: ${partialAll}室)` : '';
      progressCountText.textContent = `全 ${totalAll} 件中 ${completedAll} 件完了 (未着手: ${pendingAll} 件${partialMsg})`;
    }

    if (filteredProgressText) {
      if (filtered.length !== totalAll && filtered.length > 0) {
        const filteredPercent = Math.round((completedFiltered / filtered.length) * 100);
        const targetLabel = filterUnitTypes.length > 0 ? `対象機種` : `絞込中`;
        filteredProgressText.textContent = `${targetLabel}: ${filtered.length}件中 ${completedFiltered}件完了 (${filteredPercent}%)`;
      } else {
        filteredProgressText.textContent = '';
      }
    }

    if (countText) {
      countText.textContent = `全 ${totalAll} 件中 ${filtered.length} 件表示 (完了: ${completedFiltered} 件 / 未着手: ${pendingFiltered} 件)`;
    }

    // 一括ボタンの文言を絞り込み機種に合わせて動的に親切表示
    const batchCompleteBtn = document.getElementById('check-batch-complete-btn');
    const batchResetBtn = document.getElementById('check-batch-reset-btn');
    if (batchCompleteBtn) {
      if (filterUnitTypes.length > 0) {
        const tName = filterUnitTypes.length === 1
          ? this.getUnitTypeLabel(filterUnitTypes[0])
          : `選択${filterUnitTypes.length}機種`;
        batchCompleteBtn.innerHTML = `<span>✔️ 表示中の【${tName}】を一括完了にする</span>`;
        if (batchResetBtn) batchResetBtn.innerHTML = `<span>🔄 表示中の【${tName}】を未着手に戻す</span>`;
      } else {
        batchCompleteBtn.innerHTML = `<span>✔️ 表示中を一括完了にする</span>`;
        if (batchResetBtn) batchResetBtn.innerHTML = `<span>🔄 表示中を未着手に戻す</span>`;
      }
    }

    // 状況サマリーバー更新
    this.renderCheckStatsBar(filtered);

    if (totalAll === 0) {
      if (container) container.innerHTML = '';
      if (emptyState) {
        document.getElementById('check-empty-title').textContent = '登録データがありません';
        document.getElementById('check-empty-desc').textContent = '「現場入力」タブから各所の情報を入力してください。';
        emptyState.classList.remove('hidden');
      }
      return;
    }

    if (filtered.length === 0) {
      if (container) container.innerHTML = '';
      if (emptyState) {
        document.getElementById('check-empty-title').textContent = '条件に一致する作業データがありません';
        document.getElementById('check-empty-desc').textContent = '検索キーワードを変更するか、「条件リセット」を押して全件表示に戻してください。';
        emptyState.classList.remove('hidden');
      }
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    if (container) {
      container.innerHTML = filtered.map(r => this.renderChecklistItem(r)).join('');
    }
  }

  // 作業チェックリスト用アイテムカード生成（機器別チェック対応）
  renderChecklistItem(r) {
    const comp = this.getRecordCompletionSummary(r);
    const filterUnitTypes = this.checkMultiFilters?.unitType || [];
    
    // カードスタイルとメイン特大ボタン
    let cardClass = '';
    let checkIcon = '';
    let btnTitle = '';
    if (comp.isAllDone) {
      cardClass = 'is-completed';
      checkIcon = '✔';
      btnTitle = '全機器完了済み（タップで全機器を未着手に戻す）';
    } else if (comp.isAnyDone) {
      cardClass = 'is-partial';
      checkIcon = '◐';
      btnTitle = '一部の機器のみ完了中（タップで残りの機器も全完了にする）';
    } else {
      cardClass = '';
      checkIcon = '';
      btnTitle = '未着手（タップで全機器を一括完了にする）';
    }

    const pSlots = this.normalizePhotos(r);
    const allPhotos = [
      ...pSlots.entrance.map(p => ({ ...p, badge: '🚪 入口' })),
      ...pSlots.room.map(p => ({ ...p, badge: '🏢 部屋' })),
      ...pSlots.equipment.map(p => ({ ...p, badge: '⚙️ 機器' }))
    ];

    const photosHtml = allPhotos.length > 0 ? `
      <div class="check-photos-row">
        ${allPhotos.map(p => `
          <img src="${p.dataUrl}" alt="${p.label}" class="check-photo-thumb" title="${p.badge}: タップで拡大" onclick="app.showModalPhoto('${p.dataUrl}', '${this.escapeHtml(r.facility)} - ${this.escapeHtml(r.room)} (${p.badge})')">
        `).join('')}
      </div>
    ` : '';

    const totalUnits = r.totalUnits || ((r.pacCount || 0) + (r.hexCount || 0) + (r.fcuCount || 0));

    // 機器別チェックチップ群（タップで個別に完了/未着手を即時切替）
    const equipChipsHtml = comp.equips.map(eq => {
      const isTarget = filterUnitTypes.length > 0 && this.equipKeyMatchesFilterArray(eq.key, filterUnitTypes);
      return `
        <button type="button" 
                class="check-equip-chip ${eq.isDone ? 'is-done' : ''} ${isTarget ? 'is-highlighted' : ''}" 
                title="タップで「${this.escapeHtml(eq.label)}」の完了/未着手を個別切替" 
                onclick="event.stopPropagation(); app.toggleRecordEquipComplete('${r.id}', '${eq.key}')">
          <span class="chip-check-mark">${eq.isDone ? '✔' : '○'}</span>
          <span class="chip-equip-name">${this.escapeHtml(eq.label)}</span>
          <span class="chip-equip-count">${eq.count}台</span>
        </button>
      `;
    }).join('');

    // 完了日時の整形
    let completedMetaHtml = '';
    if (r.completedAt) {
      try {
        const d = new Date(r.completedAt);
        const timeStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        completedMetaHtml = `<div class="check-completed-meta"><span>${comp.isAllDone ? '✅ 全作業完了' : '⚡ 最終更新'}: ${timeStr}</span></div>`;
      } catch (e) {}
    }

    // ステータスタグの表示
    let statusTagHtml = '';
    if (comp.isAllDone) {
      statusTagHtml = '<span class="check-status-tag completed">✅ 全完了</span>';
    } else if (comp.isAnyDone) {
      statusTagHtml = `<span class="check-status-tag partial">⚡ 一部完了 (${comp.doneCount}/${comp.totalCount})</span>`;
    } else {
      statusTagHtml = '<span class="check-status-tag pending">⏳ 未着手</span>';
    }

    return `
      <div class="check-item-card ${cardClass}" id="check-card-${r.id}">
        <!-- 特大チェックボタン（現場の指先タップに最適・部屋全体の全完了/全未着手をトグル） -->
        <button type="button" class="check-box-btn" title="${btnTitle}" onclick="app.toggleRecordComplete('${r.id}')">
          ${checkIcon}
        </button>

        <div class="check-item-content">
          <div class="check-item-header">
            <span class="check-location-sub">🏰 [${r.park}] ${this.escapeHtml(r.area)} ＞ ${this.escapeHtml(r.facility)} ${r.floor ? `(${this.escapeHtml(r.floor)})` : ''}</span>
            ${statusTagHtml}
          </div>

          <div class="check-room-title">📍 ${this.escapeHtml(r.room)}</div>

          <!-- 機器別チェックチップ群（異なる機器を個別点検可能） -->
          ${comp.equips.length > 0 ? `
            <div class="check-equip-chips-section">
              <div class="check-equip-chips-header">
                <span>⚙️ 機器別チェック (タップで個別切替):</span>
                <span class="check-equip-progress-hint">${comp.doneCount} / ${comp.totalCount} 完了</span>
              </div>
              <div class="check-equip-chips-row">
                ${equipChipsHtml}
              </div>
            </div>
          ` : ''}

          <!-- 現場仕様タグ群 -->
          <div class="check-tags-row">
            <span class="check-tag check-tag-units">計 ${totalUnits}台</span>
            ${r.filterSpec ? `<span class="check-tag check-tag-filter" title="フィルター仕様">⚙️ ${this.escapeHtml(r.filterSpec)}</span>` : ''}
            ${r.machineNo ? `<span class="check-tag check-tag-filter" title="機番・系統">#️⃣ ${this.escapeHtml(r.machineNo)}</span>` : ''}
            ${r.equipment ? `<span class="check-tag check-tag-gear" title="必要なもの">🪜 ${this.escapeHtml(r.equipment)}</span>` : ''}
            ${r.access ? `<span class="check-tag check-tag-access" title="アクセス方法">🚪 ${this.escapeHtml(r.access)}</span>` : ''}
          </div>

          ${r.notes ? `<div class="check-notes-box">⚠️ ${this.escapeHtml(r.notes)}</div>` : ''}
          ${completedMetaHtml}
          ${photosHtml}
        </div>
      </div>
    `;
  }

  // 機器個別の作業チェックトグル操作
  async toggleRecordEquipComplete(id, equipKey) {
    const rec = this.records.find(r => r.id === id);
    if (!rec) return;

    const equips = this.getRecordEquipList(rec);
    if (!rec.completedEquip) {
      rec.completedEquip = {};
      equips.forEach(eq => {
        rec.completedEquip[eq.key] = !!rec.completed;
      });
    }

    const currentVal = this.isEquipCompleted(rec, equipKey);
    rec.completedEquip[equipKey] = !currentVal;
    this.syncRecordCompletion(rec);

    try {
      await this.saveRecord(rec);
      this.renderChecklistView();
      this.renderRecordsList();
      this.renderSpreadsheetPreview();

      const eqTarget = equips.find(e => e.key === equipKey);
      const label = eqTarget ? eqTarget.label : equipKey;
      if (rec.completedEquip[equipKey]) {
        this.showToast(`✅「${rec.room}」の【${label}】を完了にしました！`);
      } else {
        this.showToast(`⏳「${rec.room}」の【${label}】を未着手に戻しました`);
      }
    } catch (e) {
      console.error(e);
      this.showToast('機器の作業状態の更新に失敗しました', true);
    }
  }

  // 部屋全体の作業チェックトグル操作（特大メインボタン）
  async toggleRecordComplete(id) {
    const rec = this.records.find(r => r.id === id);
    if (!rec) return;

    const comp = this.getRecordCompletionSummary(rec);
    // 全完了なら全未着手に戻し、未着手または一部完了なら全完了にする
    const targetState = !comp.isAllDone;

    const equips = this.getRecordEquipList(rec);
    rec.completedEquip = rec.completedEquip || {};
    equips.forEach(eq => {
      rec.completedEquip[eq.key] = targetState;
    });
    rec.completed = targetState;
    rec.completedAt = targetState ? new Date().toISOString() : null;

    try {
      await this.saveRecord(rec);
      this.renderChecklistView();
      this.renderRecordsList();
      this.renderSpreadsheetPreview();

      if (rec.completed) {
        this.showToast(`✅「${rec.facility} - ${rec.room}」の全作業を完了にしました！`);
      } else {
        this.showToast(`⏳「${rec.facility} - ${rec.room}」を未着手に戻しました`);
      }
    } catch (e) {
      console.error(e);
      this.showToast('作業状態の更新に失敗しました', true);
    }
  }

  // 表示中を一括完了 / 一括未着手（空調機種複数選択時は選択中の機種のみを賢く一括処理）
  async batchSetChecklistComplete(targetComplete) {
    const filterUnitTypes = this.checkMultiFilters?.unitType || [];
    const filtered = this.getFilteredChecklistRecords();
    
    // 絞り込み機種がある場合とない場合の名称
    let targetName = '全機器';
    const hasUnitFilter = filterUnitTypes.length > 0;
    if (hasUnitFilter) {
      targetName = filterUnitTypes.map(u => this.getUnitTypeLabel(u)).join('・');
    }

    const targets = filtered.filter(r => {
      const isDone = this.isRecordTargetCompleted(r, filterUnitTypes);
      return targetComplete ? !isDone : isDone;
    });

    if (targets.length === 0) {
      this.showToast(targetComplete ? `表示中に対象となる未着手の【${targetName}】はありません` : `表示中に対象となる完了済みの【${targetName}】はありません`);
      return;
    }

    const actionName = targetComplete ? '「作業完了」' : '「未着手」';
    const confirmMsg = hasUnitFilter
      ? `表示中の ${targets.length} 件において、【${targetName}】のみを一括で ${actionName} に変更しますか？\n（※他の空調機器のステータスは維持されます）`
      : `表示中の ${targets.length} 件を一括で ${actionName} に変更しますか？`;

    if (!confirm(confirmMsg)) {
      return;
    }

    const now = new Date().toISOString();
    for (const r of targets) {
      const equips = this.getRecordEquipList(r);
      if (!r.completedEquip) {
        r.completedEquip = {};
        equips.forEach(eq => {
          r.completedEquip[eq.key] = !!r.completed;
        });
      }

      if (hasUnitFilter) {
        // 選択中の機種群のみ対象
        equips.forEach(eq => {
          if (this.equipKeyMatchesFilterArray(eq.key, filterUnitTypes)) {
            r.completedEquip[eq.key] = targetComplete;
          }
        });
        this.syncRecordCompletion(r);
      } else {
        // 全機器対象
        equips.forEach(eq => {
          r.completedEquip[eq.key] = targetComplete;
        });
        r.completed = targetComplete;
        r.completedAt = targetComplete ? now : null;
      }
      await this.saveRecord(r);
    }

    this.renderChecklistView();
    this.renderRecordsList();
    this.renderSpreadsheetPreview();
    this.showToast(`✨ ${targets.length} 件の【${targetName}】を一括で ${actionName} に更新しました！`);
  }

  // 作業サマリー集計バー
  renderCheckStatsBar(records) {
    const bar = document.getElementById('check-stats-bar');
    if (!bar) return;

    if (records.length === 0) {
      bar.innerHTML = '';
      return;
    }

    let totalUnits = 0;
    records.forEach(r => {
      totalUnits += (r.totalUnits || ((r.pacCount || 0) + (r.hexCount || 0) + (r.fcuCount || 0)));
    });

    const doneCount = records.filter(r => r.completed).length;
    const pendingCount = records.length - doneCount;

    bar.innerHTML = `
      <span class="stat-pill highlight">表示中: ${records.length} 室</span>
      <span class="stat-pill">❄️ 機器計: ${totalUnits} 台</span>
      <span class="stat-pill cyan">✅ 完了: ${doneCount} 室</span>
      <span class="stat-pill" style="color:#fbbf24; border-color:rgba(245,158,11,0.4);">⏳ 未着手: ${pendingCount} 室</span>
    `;
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
    } else if (tabId === 'tab-check') {
      this.renderChecklistView();
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

  // 文字列の高度な正規化（全角英数・半角英数、全角カナ・半角カナ、大文字小文字、ひらがな/カタカナ、記号、スペースの統一）
  normalizeSearchText(str) {
    if (!str) return '';
    return String(str)
      .normalize('NFKC') // 全角英数・半角カナをUnicode正規化
      .toLowerCase()
      // ひらがなをカタカナに統一（例: "ころんびあ" → "コロンビア"）
      .replace(/[\u3041-\u3096]/g, match => String.fromCharCode(match.charCodeAt(0) + 0x60))
      // 記号（ドット、中黒、ハイフン、スラッシュ、長音符など）を除去またはスペース化
      .replace(/[・\.\-\_\/／、，,\s　]+/g, ' ')
      .trim();
  }

  // あいまい・部分一致検索判定（スペース区切りでの複数キーワードAND検索、「-キーワード」で除外検索対応）
  matchesSearchQuery(targetString, searchInput) {
    if (!searchInput) return true;
    const normTarget = this.normalizeSearchText(targetString);
    const compactTarget = normTarget.replace(/\s+/g, '');
    const rawTokens = String(searchInput).trim().split(/[\s　]+/).filter(Boolean);
    if (rawTokens.length === 0) return true;

    return rawTokens.every(tok => {
      const isExclude = tok.startsWith('-') && tok.length > 1;
      const cleanTok = isExclude ? tok.slice(1) : tok;
      const kw = this.normalizeSearchText(cleanTok);
      if (!kw) return true;
      const compactKw = kw.replace(/\s+/g, '');
      const hit = normTarget.includes(kw) || (compactKw && compactTarget.includes(compactKw));
      return isExclude ? !hit : hit;
    });
  }

  // レコード内の全属性（施設・部屋・階層・機器種別・仕様・機材・アクセス・備考）を網羅した検索テキスト生成
  buildRecordSearchText(r) {
    if (!r) return '';
    const subs = r.pacSubtypes || {};
    const equipParts = [
      subs.cassette > 0 ? '天カセ カセット' : '',
      subs.floor > 0 ? '床置 床置き' : '',
      subs.ceiling > 0 ? '天吊 天吊り 天井吊' : '',
      subs.wall > 0 ? '壁掛 壁掛け' : '',
      subs.duct > 0 ? '隠蔽ダクト ダクト ビルトインダクト ビルトイン' : '',
      subs.other > 0 ? '他pac その他pac' : '',
      subs.unknown > 0 ? 'pac種別確認中 pac確認中 pac' : '',
      (r.hexCount > 0) ? '全熱 全熱交換器 ロスナイ ベンティエール hex' : '',
      (r.fcuCount > 0) ? 'fcu ファンコイル ファンコイルユニット' : '',
      r.otherEquipment || '',
      r.equipSummary || ''
    ].filter(Boolean).join(' ');

    const parkKeywords = {
      'TDS': 'tds シー ディズニーシー disneysea',
      'TDL': 'tdl ランド ディズニーランド disneyland',
      'HOTEL': 'hotel ホテル ミラコスタ アンバサダー ファンタジースプリングスホテル',
      'OTHER': 'other その他'
    }[r.park] || '';

    return [
      r.resort || '',
      r.park || '',
      parkKeywords,
      r.area || '',
      r.facility || '',
      r.floor || '',
      r.room || '',
      equipParts,
      r.equipment || '',
      r.access || '',
      r.filterSpec || '',
      r.machineNo || '',
      r.notes || ''
    ].join(' ');
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
