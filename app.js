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
    const cOther = parseInt(document.getElementById('pac-other-count')?.value || '0', 10) || 0;
    const cUnk = parseInt(document.getElementById('pac-unknown-count')?.value || '0', 10) || 0;

    const pacSubtypes = {
      cassette: cCas,
      floor: cFloor,
      ceiling: cCeil,
      wall: cWall,
      other: cOther,
      unknown: cUnk
    };

    const pacTotal = cCas + cFloor + cCeil + cWall + cOther + cUnk;
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
        this.updateHeaderBadge();
        this.updateDynamicFilterOptions();
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

    // エリア・施設・階層・部屋名の入力イベント（すべてリアルタイムにパスプレビュー＆チップハイライト＆自動保存）
    ['area-input', 'facility-input', 'floor-input', 'room-input'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => {
          this.updatePathPreview();
          this.renderAllChips();
          this.scheduleSaveDraft();
        });
        el.addEventListener('change', () => {
          this.updatePathPreview();
          this.renderAllChips();
          this.scheduleSaveDraft();
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
    ['pac-cassette-count', 'pac-floor-count', 'pac-ceiling-count', 'pac-wall-count', 'pac-other-count', 'pac-unknown-count', 'hex-count', 'fcu-count'].forEach(id => {
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
        'filter-photo-select'
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

    document.getElementById('scroll-to-top-btn').addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    // シート出力タブ: まとめ方（4種類のシート形式）切替
    document.querySelectorAll('#export-mode-tabs .view-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#export-mode-tabs .view-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.exportSheetMode = btn.dataset.exportMode || 'expanded';
        this.renderSpreadsheetPreview();
      });
    });

    document.getElementById('export-use-filter-toggle')?.addEventListener('change', () => {
      this.renderSpreadsheetPreview();
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

  updateParkAreas() {
    const datalist = document.getElementById('area-datalist');
    if (datalist) {
      const candidateAreas = this.candidates.area || [];
      const recordAreas = this.records.filter(r => r.park === this.selectedPark).map(r => r.area);
      const uniqueAreas = Array.from(new Set([...candidateAreas, ...recordAreas].filter(Boolean)));
      datalist.innerHTML = uniqueAreas.map(a => `<option value="${this.escapeHtml(a)}"></option>`).join('');
    }
    this.updateAreaFacilities();
    this.updatePathPreview();
    this.renderAllChips();
  }

  updateAreaFacilities() {
    const datalist = document.getElementById('facility-datalist');
    if (datalist) {
      const candidateFacs = this.candidates.facility || [];
      const recordFacs = this.records.filter(r => r.park === this.selectedPark).map(r => r.facility);
      const uniqueFacs = Array.from(new Set([...candidateFacs, ...recordFacs].filter(Boolean)));
      datalist.innerHTML = uniqueFacs.map(f => `<option value="${this.escapeHtml(f)}"></option>`).join('');
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
      this.showToast(wasEditing ? 'データを更新しました！' : 'リストに追加しました！（場所・階層・アクセスを引き継ぎます）');
      
      // 連続入力しやすいよう、登録後は「パーク・エリア・施設名・階層・アクセス方法」を残し、部屋名や台数・写真のみクリアする
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

    // keepContinuousFields=true の場合は「エリア・施設名・階層・アクセス方法」を残し、それ以外をクリア
    const fieldsToClear = keepContinuousFields
      ? ['room-input', 'equipment-input', 'other-equip-input', 'machine-no-input', 'filter-spec-input', 'notes-input']
      : ['area-input', 'facility-input', 'floor-input', 'room-input', 'access-input', 'equipment-input', 'other-equip-input', 'machine-no-input', 'filter-spec-input', 'notes-input'];

    fieldsToClear.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    
    // ステッパーリセット (PAC各形式・全熱・FCU)
    ['pac-cassette-count', 'pac-floor-count', 'pac-ceiling-count', 'pac-wall-count', 'pac-other-count', 'pac-unknown-count', 'hex-count', 'fcu-count'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '0';
    });
    this.updateTotalUnits();

    this.updateParkAreas();
    this.renderAllPhotoSlots();
    this.togglePhotoSection(false);
    this.updatePathPreview();
    this.renderAllChips();
    this.isRestoringDraft = false;

    if (keepContinuousFields) {
      // 引き継いだ「エリア・施設・階層・アクセス」を下書きとしても保存しておく（タスクキルしても残るように）
      await this.saveDraftNow();
      const statusText = document.getElementById('draft-status-text');
      if (statusText) {
        statusText.textContent = '📍 前回の「エリア・施設名・階層・アクセス」を引き継ぎ中（続けて次の部屋を入力できます）';
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
    document.getElementById('pac-other-count').value = subs.other || (rec.pacCount && !subs.cassette && !subs.floor && !subs.ceiling && !subs.wall && !subs.unknown ? rec.pacCount : 0);
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
    document.getElementById('pac-other-count').value = subs.other || (rec.pacCount && !subs.cassette && !subs.floor && !subs.ceiling && !subs.wall && !subs.unknown ? rec.pacCount : 0);
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
      const uniqueVals = Array.from(new Set(values.filter(v => v && String(v).trim().length > 0)));
      if (sortFn) uniqueVals.sort(sortFn);
      else uniqueVals.sort((a, b) => a.localeCompare(b, 'ja'));

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
      (a, b) => this.parseFloorOrder(a) - this.parseFloorOrder(b) || a.localeCompare(b, 'ja')
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
      'filter-photo-select'
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

      list = list.filter(r => {
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
          if (filterUnitType === 'other_pac' && !(subs.other > 0)) return false;
          if (filterUnitType === 'unknown_pac' && !(subs.unknown > 0)) return false;
          if (filterUnitType === 'pac_any' && !(pac > 0 || (subs.cassette || 0) + (subs.floor || 0) + (subs.ceiling || 0) + (subs.wall || 0) + (subs.other || 0) + (subs.unknown || 0) > 0)) return false;
          if (filterUnitType === 'hex' && !(hex > 0)) return false;
          if (filterUnitType === 'fcu' && !(fcu > 0)) return false;
          if (filterUnitType === 'other' && !other) return false;
        }

        if (filterEquip) {
          const combined = `${r.equipment || ''} ${r.access || ''}`;
          if (!combined.includes(filterEquip)) return false;
        }

        if (filterPhoto) {
          const p = this.normalizePhotos(r);
          const totalP = p.entrance.length + p.room.length + p.equipment.length;
          if (filterPhoto === 'has_photo' && totalP === 0) return false;
          if (filterPhoto === 'missing_photo' && (p.entrance.length > 0 && p.room.length > 0)) return false;
        }

        if (searchWord) {
          const targetStr = `${r.resort} ${r.park} ${r.area} ${r.facility} ${r.floor || ''} ${r.room} ${r.equipSummary || ''} ${r.access || ''} ${r.equipment || ''} ${r.filterSpec || ''} ${r.machineNo || ''} ${r.notes || ''}`.toLowerCase();
          if (!targetStr.includes(searchWord)) return false;
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
    let cas = 0, flr = 0, ceil = 0, wall = 0, pacOth = 0, pacUnk = 0, hex = 0, fcu = 0;
    const facSet = new Set();

    filtered.forEach(r => {
      if (r.facility) facSet.add(`${r.park}:${r.facility}`);
      const subs = r.pacSubtypes || {};
      const cCas = subs.cassette || 0;
      const cFlr = subs.floor || 0;
      const cCeil = subs.ceiling || 0;
      const cWall = subs.wall || 0;
      const cOth = subs.other || (r.pacCount && !cCas && !cFlr && !cCeil && !cWall && !subs.unknown ? r.pacCount : 0);
      const cUnk = subs.unknown || 0;
      cas += cCas;
      flr += cFlr;
      ceil += cCeil;
      wall += cWall;
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

    return `
      <div class="record-card">
        <div class="card-header-path">
          <div class="path-tag-row">
            <span class="park-tag ${parkClass}">${r.park}</span>
            <span class="area-tag">${this.escapeHtml(r.area || 'エリア未設定')}</span>
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
      { key: 'pac_other', label: '❄️ パッケージ (その他)', badgeClass: 'badge-pac-other', getter: r => {
        const s = r.pacSubtypes || {};
        return s.other || (r.pacCount && !s.cassette && !s.floor && !s.ceiling && !s.wall && !s.unknown ? r.pacCount : 0);
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

  // ================= 9. スプレッドシート連携（4種のまとめ方シート出力＆フィルタ連動） =================
  getTargetRecordsForExport() {
    const useFilter = document.getElementById('export-use-filter-toggle')?.checked ?? true;
    return this.getFilteredAndSortedRecords(!useFilter);
  }

  getExpandedRows(sourceRecords = null) {
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
      const cOth = subs.other || (r.pacCount && !cCas && !cFloor && !cCeil && !cWall && !subs.unknown ? r.pacCount : 0);
      const cUnk = subs.unknown || 0;

      let pacHandled = false;
      if (cCas > 0) { items.push({ type: 'パッケージ (天カセ)', count: `${cCas}台`, num: cCas }); pacHandled = true; }
      if (cFloor > 0) { items.push({ type: 'パッケージ (床置き)', count: `${cFloor}台`, num: cFloor }); pacHandled = true; }
      if (cCeil > 0) { items.push({ type: 'パッケージ (天吊り)', count: `${cCeil}台`, num: cCeil }); pacHandled = true; }
      if (cWall > 0) { items.push({ type: 'パッケージ (壁掛け)', count: `${cWall}台`, num: cWall }); pacHandled = true; }
      if (cOth > 0) { items.push({ type: 'パッケージ (その他)', count: `${cOth}台`, num: cOth }); pacHandled = true; }
      if (cUnk > 0) { items.push({ type: 'パッケージ (種別確認中)', count: `${cUnk}台`, num: cUnk }); pacHandled = true; }

      if (!pacHandled && pac > 0) {
        items.push({ type: 'パッケージ (PAC)', count: `${pac}台`, num: pac });
      }

      if (hex > 0) items.push({ type: '全熱交換器 (HEX)', count: `${hex}台`, num: hex });
      if (fcu > 0) items.push({ type: 'ファンコイル (FCU)', count: `${fcu}台`, num: fcu });
      if (other) items.push({ type: 'その他機器', count: other, num: 1 });

      if (items.length === 0) {
        items.push({ type: '空調機未登録', count: '-', num: 0 });
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

  // 4種類のシート形式（①機器別詳細 / ②部屋別1行まとめ / ③施設・階層別集計 / ④機種・仕様別集計）のデータ生成
  buildSheetDataset(mode, sourceRecords = null) {
    const records = sourceRecords || this.getTargetRecordsForExport();

    // ① 機器別詳細リスト（18列・行分割）
    if (mode === 'expanded') {
      const exp = this.getExpandedRows(records);
      const headers = [
        'No', 'パーク', 'エリア', '施設/アトラクション', '階層', '部屋名',
        '空調機種別', '台数', '作業に必要なもの', 'アクセス方法',
        '建物入口写真', '部屋写真', '機器写真',
        'フィルター仕様', '機番・系統', '特記事項', '階層フルパス', '登録日時'
      ];
      const rows = exp.map(r => [
        r.no, r.park, r.area, r.facility, r.floor || '-', r.room,
        r.equipType, r.equipCount, r.equipment || '-', r.access || '-',
        r.entrancePhotos.length > 0 ? `あり(${r.entrancePhotos.length}枚)` : 'なし',
        r.roomPhotos.length > 0 ? `あり(${r.roomPhotos.length}枚)` : 'なし',
        r.equipPhotos.length > 0 ? `あり(${r.equipPhotos.length}枚)` : 'なし',
        r.filterSpec || '-', r.machineNo || '-', r.notes || '',
        r.fullPath, new Date(r.createdAt).toLocaleString('ja-JP')
      ]);
      const colWidths = [
        { wch: 5 }, { wch: 8 }, { wch: 20 }, { wch: 24 }, { wch: 8 }, { wch: 18 },
        { wch: 20 }, { wch: 9 }, { wch: 28 }, { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
        { wch: 20 }, { wch: 14 }, { wch: 24 }, { wch: 42 }, { wch: 18 }
      ];
      return { sheetName: '①機器別詳細リスト', title: '📋 ① 機器別詳細リスト (18列)', headers, rows, colWidths };
    }

    // ② 部屋別まとめリスト（1部屋1行・機種別台数横並び）
    if (mode === 'room_summary') {
      const headers = [
        'No', 'パーク', 'エリア', '施設/アトラクション', '階層', '部屋名',
        '合計台数', '天カセ', '床置き', '天吊り', '壁掛け', '他PAC', '確認中', '全熱(HEX)', 'FCU', 'その他機器',
        '作業に必要なもの', 'アクセス方法', 'フィルター仕様', '機番・系統', '特記事項'
      ];
      const rows = records.map((r, idx) => {
        const s = r.pacSubtypes || {};
        const cCas = s.cassette || 0;
        const cFlr = s.floor || 0;
        const cCeil = s.ceiling || 0;
        const cWall = s.wall || 0;
        const cOth = s.other || (r.pacCount && !cCas && !cFlr && !cCeil && !cWall && !s.unknown ? r.pacCount : 0);
        const cUnk = s.unknown || 0;
        const hex = r.hexCount || 0;
        const fcu = r.fcuCount || 0;
        const tot = r.totalUnits || ((r.pacCount || 0) + hex + fcu);
        return [
          idx + 1, r.park, r.area, r.facility, r.floor || '-', r.room,
          `${tot}台`, cCas || '-', cFlr || '-', cCeil || '-', cWall || '-', cOth || '-', cUnk || '-', hex || '-', fcu || '-', r.otherEquipment || '-',
          r.equipment || '-', r.access || '-', r.filterSpec || '-', r.machineNo || '-', r.notes || ''
        ];
      });
      const colWidths = [
        { wch: 5 }, { wch: 8 }, { wch: 18 }, { wch: 22 }, { wch: 8 }, { wch: 18 },
        { wch: 10 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 16 },
        { wch: 26 }, { wch: 26 }, { wch: 18 }, { wch: 14 }, { wch: 22 }
      ];
      return { sheetName: '②部屋別まとめリスト', title: '🏢 ② 部屋別まとめリスト (1部屋1行)', headers, rows, colWidths };
    }

    // ③ 施設・階層別 集計表
    if (mode === 'facility_summary') {
      const headers = [
        'No', 'パーク', 'エリア', '施設/アトラクション', '階層',
        '登録部屋数', '空調機合計', '天カセ計', '床置き計', '天吊り計', '壁掛け計', '他PAC計', '確認中計', '全熱(HEX)計', 'FCU計',
        '対象部屋一覧', '必要機材まとめ'
      ];
      const map = new Map();
      records.forEach(r => {
        const key = `${r.park}__${r.area}__${r.facility}__${r.floor || '-'}`;
        if (!map.has(key)) {
          map.set(key, {
            park: r.park, area: r.area, facility: r.facility, floor: r.floor || '-',
            roomCount: 0, total: 0, cas: 0, flr: 0, ceil: 0, wall: 0, oth: 0, unk: 0, hex: 0, fcu: 0,
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
        g.oth += (s.other || (r.pacCount && !s.cassette && !s.floor && !s.ceiling && !s.wall && !s.unknown ? r.pacCount : 0));
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
        g.cas || '-', g.flr || '-', g.ceil || '-', g.wall || '-', g.oth || '-', g.unk || '-', g.hex || '-', g.fcu || '-',
        g.rooms.join(', '), Array.from(g.gears).join(' / ') || '-'
      ]);
      const colWidths = [
        { wch: 5 }, { wch: 8 }, { wch: 18 }, { wch: 24 }, { wch: 8 },
        { wch: 10 }, { wch: 10 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 11 }, { wch: 9 },
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

    const targetRecords = this.getTargetRecordsForExport();
    const useFilter = document.getElementById('export-use-filter-toggle')?.checked ?? true;
    if (filterBadge) {
      if (useFilter && this.hasActiveFilters()) {
        filterBadge.textContent = `🔍 絞り込み適用中 (${targetRecords.length}/${this.records.length}室)`;
        filterBadge.className = 'badge badge-success';
      } else {
        filterBadge.textContent = `全件対象 (${this.records.length}室)`;
        filterBadge.className = 'badge';
      }
    }

    const dataset = this.buildSheetDataset(this.exportSheetMode, targetRecords);
    if (titleEl) {
      titleEl.innerHTML = `${dataset.title} (全 <span id="preview-row-count">${dataset.rows.length}</span> 行)`;
    }

    thead.innerHTML = `<tr>${dataset.headers.map(h => `<th>${this.escapeHtml(h)}</th>`).join('')}</tr>`;

    if (dataset.rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${dataset.headers.length}" style="text-align:center; padding:20px; color:#94a3b8;">データがありません</td></tr>`;
      return;
    }

    tbody.innerHTML = dataset.rows.map(row => `
      <tr>
        ${row.map((cell, idx) => {
          const val = this.escapeHtml(String(cell ?? ''));
          if (idx === 6 && this.exportSheetMode === 'expanded') {
            return `<td style="color:#38bdf8; font-weight:700;">● ${val}</td>`;
          }
          if ((idx === 7 && this.exportSheetMode === 'expanded') || (idx === 6 && this.exportSheetMode === 'room_summary')) {
            return `<td style="text-align:center; color:#fbbf24; font-weight:700;">${val}</td>`;
          }
          return `<td>${val}</td>`;
        }).join('')}
      </tr>
    `).join('');
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

  // Excelダウンロード（全4種類のまとめ方シートを1つのExcelブックに一括収録！）
  downloadXLSX() {
    const targetRecords = this.getTargetRecordsForExport();
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
    const modesOrder = [
      this.exportSheetMode,
      ...['expanded', 'room_summary', 'facility_summary', 'equip_summary'].filter(m => m !== this.exportSheetMode)
    ];

    modesOrder.forEach(mode => {
      const ds = this.buildSheetDataset(mode, targetRecords);
      const aoa = [ds.headers, ...ds.rows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = ds.colWidths;
      XLSX.utils.book_append_sheet(wb, ws, ds.sheetName);
    });

    XLSX.writeFile(wb, `TDR_空調設備現場リスト_全4種集計入_${this.getFormattedDate()}.xlsx`);
    this.showToast('📗 全4シート収録のExcelファイルをダウンロードしました！');
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
