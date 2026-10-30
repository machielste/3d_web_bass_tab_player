import { visibleRange, ROW_HEIGHT, PAGE_SIZE, formatTime } from './virtual-list.js';

const $ = id => document.getElementById(id);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
export async function api(path, body) {
  const response = await fetch(`/api/library/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The library request failed.');
  return result;
}

export async function waitJob(job, current = () => true) {
  while (current()) {
    const result = await api(`jobs/${job}`);
    if (!current()) return null;
    if (result.state === 'ready') return result.result;
    if (result.state === 'cancelled') return null;
    if (result.state === 'error') throw new Error(result.error);
    await pause(result.state === 'working' ? 350 : 200);
  }
  return null;
}

function node(tag, className, text = '') {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function cover(song, className) {
  const element = node('div', `cover ${className}`);
  element.setAttribute('aria-hidden', 'true');
  element.append(node('span', 'cover-symbol', '≋'));
  if (song.art_url) {
    const img = document.createElement('img');
    img.alt = ''; img.src = song.art_url; img.decoding = 'async';
    img.addEventListener('error', () => img.remove(), { once: true });
    element.append(img);
  }
  return element;
}

export class SongLibrary {
  constructor(onPlay) {
    this.onPlay = onPlay;
    this.pages = new Map(); this.pending = new Map();
    this.generation = 0; this.total = 0; this.snapshot = ''; this.selection = 0;
    this.selected = null; this.selectedIndex = -1; this.visible = true;
    this.client = crypto.randomUUID(); this.audio = $('preview-audio');
    this.audio.volume = .4;
    this.previewEnabled = localStorage.getItem('song-previews') !== 'off';
    $('preview-enabled').checked = this.previewEnabled;
    this.audio.addEventListener('ended', () => this.previewMessage('Preview finished'));
    $('song-list').addEventListener('scroll', () => this.scheduleRender(), { passive: true });
    new ResizeObserver(() => this.scheduleRender()).observe($('song-list'));
    $('song-list').addEventListener('keydown', event => this.keydown(event));
    $('library-search').addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.refresh(), 120);
    });
    for (const id of ['library-sort', 'library-format']) $(id).addEventListener('change', () => this.refresh());
    $('refresh-library').addEventListener('click', () => this.refresh(true));
    $('folders').addEventListener('click', () => $('folder-dialog').showModal());
    $('empty-add-folder').addEventListener('click', () => $('folder-dialog').showModal());
    $('close-folders').addEventListener('click', () => $('folder-dialog').close());
    $('folder-dialog').addEventListener('close', () => api('folders/pick/cancel', {}).catch(() => {}));
    $('folder-form').addEventListener('submit', event => { event.preventDefault(); this.addFolder(); });
    $('browse-folder').addEventListener('click', () => this.browseFolder());
    $('rescan').addEventListener('click', async () => {
      try { await api('rescan', {}); $('scan-status').textContent = 'Checking folders…'; }
      catch (error) { this.notice(error.message, true); }
    });
    $('skipped-files').addEventListener('toggle', async () => {
      if (!$('skipped-files').open) return;
      try {
        const result = await api('errors');
        $('skipped-list').replaceChildren(...result.items.map(item => node('li', '', `${item.path.split(/[\\/]/).pop()} — ${item.error}`)));
      } catch (error) { this.notice(error.message, true); }
    });
    $('preview-enabled').addEventListener('change', () => {
      this.previewEnabled = $('preview-enabled').checked;
      localStorage.setItem('song-previews', this.previewEnabled ? 'on' : 'off');
      this.stopPreview();
      if (this.previewEnabled && this.selected) this.preview(this.selected, this.selection);
      else this.previewMessage('Previews off');
    });
    $('preview-replay').addEventListener('click', () => {
      this.stopPreview();
      if (this.selected) this.preview(this.selected, this.selection, true);
    });
    $('play-selected').addEventListener('click', () => this.playSelected());
    this.refresh(); this.pollStatus();
  }

  notice(text = '', error = false) {
    $('library-message').textContent = text;
    $('library-message').classList.toggle('error', error);
  }

  previewMessage(text) { $('preview-status').textContent = text; }

  setVisible(visible) {
    this.visible = visible;
    if (!visible) this.stopPreview();
    else { this.scheduleRender(); this.pollStatus(); }
  }

  stopPreview() {
    clearTimeout(this.previewTimer);
    this.selection++;
    this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
    if (this.selected) this.previewMessage('Preview paused');
    api('preview/cancel', { client: this.client, selection: this.selection }).catch(() => {});
  }

  async preview(song, selection, force = false) {
    if ((!this.previewEnabled && !force) || !song.available || !this.visible) return;
    const current = () => this.visible && selection === this.selection;
    this.previewMessage('Loading preview…');
    try {
      const { job } = await api('preview', { id: song.id, client: this.client, selection });
      if (!current()) return;
      const result = await waitJob(job, current);
      if (!result || !current()) return;
      this.audio.src = result.audio_url;
      await this.audio.play();
      if (!current()) { this.audio.pause(); return; }
      this.previewMessage('Playing preview');
    } catch (error) {
      if (current()) this.previewMessage(error.name === 'NotAllowedError' ? 'Press Preview to listen' : `Preview unavailable: ${error.message}`);
    }
  }

  select(song, index, user = true) {
    if (!song) return;
    this.stopPreview();
    this.selected = song; this.selectedIndex = index;
    $('selected-cover').replaceChildren(cover(song, 'detail-cover'));
    $('selected-title').textContent = song.title;
    $('selected-artist').textContent = song.artist || 'Unknown artist';
    $('selected-album').textContent = song.album || '—';
    $('selected-duration').textContent = formatTime(song.duration);
    $('selected-format').textContent = song.format || '—';
    $('selected-tuning').replaceChildren(...song.tuning.map(name => node('span', 'tuning-note', name)));
    $('selected-file').textContent = song.path?.split(/[\\/]/).pop() || '';
    $('selected-file').title = song.path || '';
    $('song-detail').hidden = false; $('no-selection').hidden = true;
    $('play-selected').disabled = !song.available;
    $('preview-replay').disabled = !song.available;
    this.previewMessage(!song.available ? 'File unavailable. Check its folder.' : this.previewEnabled ? 'Preview ready' : 'Previews off');
    this.scheduleRender();
    if (user) {
      const selection = this.selection;
      this.previewTimer = setTimeout(() => this.preview(song, selection), 300);
    }
  }

  async playSelected() {
    if (!this.selected?.available) return;
    this.stopPreview();
    await this.onPlay(this.selected);
  }

  async refresh(preserve = false) {
    const list = $('song-list');
    const top = Math.floor(list.scrollTop / ROW_HEIGHT);
    const anchor = preserve ? this.item(top)?.id || '' : '';
    const remainder = list.scrollTop % ROW_HEIGHT;
    if (!preserve) {
      this.stopPreview(); this.selected = null;
      $('song-detail').hidden = true; $('no-selection').hidden = false;
    }
    const generation = ++this.generation;
    this.refreshing = true;
    if (!preserve) this.notice('Loading library…');
    try {
      const params = new URLSearchParams({ q: $('library-search').value, sort: $('library-sort').value, format: $('library-format').value, anchor, selected: this.selected?.id || '' });
      const result = await api(`songs?${params}`);
      if (generation !== this.generation) return;
      this.pages.clear(); this.pending.clear();
      this.pageError = false; this.refreshing = false;
      this.snapshot = result.snapshot; this.total = result.total;
      this.selectedIndex = result.selected_index;
      this.pages.set(0, result.items);
      $('catalog-spacer').style.height = `${this.total * ROW_HEIGHT}px`;
      list.scrollTop = result.anchor_index >= 0 ? result.anchor_index * ROW_HEIGHT + remainder : 0;
      $('result-count').textContent = `${this.total.toLocaleString()} ${this.total === 1 ? 'song' : 'songs'}`;
      $('library-empty').hidden = this.total > 0;
      this.notice();
      if (this.selected && result.selected_index < 0) {
        this.stopPreview(); this.selected = null;
        $('song-detail').hidden = true; $('no-selection').hidden = false;
      }
      if (this.selected && result.selected_item && JSON.stringify(this.selected) !== JSON.stringify(result.selected_item)) {
        this.select(result.selected_item, result.selected_index, false);
      }
      if (!this.selected && result.items.length) this.select(result.items[0], 0, false);
      this.render();
    } catch (error) { if (generation === this.generation) { this.refreshing = false; this.notice(error.message, true); } }
  }

  scheduleRender() {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => { this.renderQueued = false; if (this.visible) this.render(); });
  }

  item(index) { return this.pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE]; }

  async fetchPage(page) {
    if (this.pending.has(page)) return this.pending.get(page);
    if (this.refreshing || this.pageError || !this.snapshot || this.pages.has(page)) return;
    const generation = this.generation;
    const work = (async () => { try {
      const result = await api(`songs?${new URLSearchParams({ snapshot: this.snapshot, offset: page * PAGE_SIZE })}`);
      if (generation !== this.generation) return;
      this.pages.set(page, result.items);
      while (this.pages.size > 8) {
        const candidate = [...this.pages.keys()].find(p => p !== page && Math.abs(p - page) > 1);
        if (candidate === undefined) break;
        this.pages.delete(candidate);
      }
      this.scheduleRender();
    } catch (error) { if (generation === this.generation) { this.pageError = true; this.notice(`${error.message} Use Refresh list to retry.`, true); } }
    finally { if (generation === this.generation) { this.pending.delete(page); this.scheduleRender(); } } })();
    this.pending.set(page, work);
    return work;
  }

  render() {
    const list = $('song-list');
    const { start, end } = visibleRange(list.scrollTop, list.clientHeight, this.total);
    $('catalog-rows').style.transform = `translateY(${start * ROW_HEIGHT}px)`;
    const existing = new Map([...$('catalog-rows').children].map(child => [child.dataset.index, child]));
    const rows = [];
    for (let index = start; index < end; index++) {
      const song = this.item(index);
      let row = existing.get(String(index));
      if (!row || row.dataset.song !== song?.id) {
        row = node('div', `song-row${song ? '' : ' row-loading'}`);
        row.dataset.index = index;
        row.setAttribute('role', 'option');
        row.id = `song-row-${index}`;
        if (song) {
          row.dataset.song = song.id;
          row.append(cover(song, 'row-cover'));
          const info = node('div', 'row-info');
          info.append(node('span', 'row-title', song.title), node('span', 'row-artist', [song.artist || 'Unknown artist', song.album].filter(Boolean).join(' · ')));
          row.append(info, node('span', 'row-tuning', song.tuning.join(' ')), node('span', 'row-duration', formatTime(song.duration)));
          row.classList.toggle('unavailable', !song.available);
          row.addEventListener('click', () => { list.focus({ preventScroll: true }); this.select(song, index); });
          row.addEventListener('dblclick', () => { this.select(song, index); this.playSelected(); });
        } else {
          row.append(node('div', 'row-skeleton'));
        }
      }
      const selected = !!song && song.id === this.selected?.id;
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', String(selected));
      rows.push(row);
    }
    // Reuse covers and rows during scrolling; avoid re-requesting decoded images.
    $('catalog-rows').replaceChildren(...rows);
    if (this.selectedIndex >= start && this.selectedIndex < end) list.setAttribute('aria-activedescendant', `song-row-${this.selectedIndex}`);
    else list.removeAttribute('aria-activedescendant');
    const wanted = new Set();
    for (let i = start; i < end; i++) wanted.add(Math.floor(i / PAGE_SIZE));
    // Two visible pages at most for a normal viewport; scrolling never queues
    // the pages between the old and new scroll positions.
    for (const page of wanted) if (this.pending.size < 2) this.fetchPage(page);
  }

  async keydown(event) {
    if (event.key === 'Enter') { event.preventDefault(); this.playSelected(); return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key) || !this.total) return;
    event.preventDefault();
    const jump = Math.max(1, Math.floor($('song-list').clientHeight / ROW_HEIGHT));
    let index = Math.max(0, this.selectedIndex);
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = this.total - 1;
    else index += ({ ArrowUp: -1, ArrowDown: 1, PageUp: -jump, PageDown: jump })[event.key];
    index = Math.max(0, Math.min(this.total - 1, index));
    const list = $('song-list');
    if (index * ROW_HEIGHT < list.scrollTop) list.scrollTop = index * ROW_HEIGHT;
    else if ((index + 1) * ROW_HEIGHT > list.scrollTop + list.clientHeight) list.scrollTop = (index + 1) * ROW_HEIGHT - list.clientHeight;
    await this.fetchPage(Math.floor(index / PAGE_SIZE));
    this.select(this.item(index), index);
  }

  async pollStatus() {
    clearTimeout(this.statusTimer);
    if (this.polling) return;
    this.polling = true;
    try {
      const status = await api('status');
      const wasScanning = this.status?.scanning;
      const oldTotal = this.status?.total || 0;
      const oldRevision = this.status?.revision;
      this.status = status;
      $('scan-status').textContent = status.error ? `Folder check failed: ${status.error}` : status.scanning ? `Checking folders · ${status.checked.toLocaleString()} files · ${status.indexed.toLocaleString()} updated` : `${status.total.toLocaleString()} songs in your library`;
      $('rescan').disabled = status.scanning;
      $('skipped-files').hidden = !status.skipped;
      $('skipped-summary').textContent = `${status.skipped} files skipped`;
      const signature = JSON.stringify(status.roots);
      if (signature !== this.rootSignature) {
        this.rootSignature = signature;
        $('folder-list').replaceChildren(...status.roots.map(root => {
          const li = node('li', 'folder-row');
          const info = node('div', 'folder-info');
          info.append(node('span', '', root.path), node('small', root.error ? 'folder-error' : '', root.error || 'Includes subfolders'));
          const remove = node('button', 'text-button', 'Remove'); remove.type = 'button';
          remove.setAttribute('aria-label', `Remove folder ${root.path}`);
          remove.addEventListener('click', async () => {
            try { await api('folders/remove', { id: root.id }); this.stopPreview(); this.selected = null; $('song-detail').hidden = true; $('no-selection').hidden = false; await this.refresh(); this.pollStatus(); }
            catch (error) { $('folder-message').textContent = error.message; }
          });
          li.append(info, remove); return li;
        }));
        $('no-folders').hidden = status.roots.length > 0;
      }
      if ((!this.total && status.total > oldTotal) || (wasScanning && !status.scanning) || (oldRevision !== undefined && oldRevision !== status.revision && !status.scanning) || (status.scanning && status.total > oldTotal && Date.now() - (this.lastCatalogRefresh || 0) > 10000)) {
        if (this.visible) { await this.refresh(true); this.lastCatalogRefresh = Date.now(); }
        else this.needsRefresh = true;
      }
      if (this.visible && this.needsRefresh) { this.needsRefresh = false; await this.refresh(true); }
    } catch (error) { if (this.visible) this.notice(error.message, true); }
    this.polling = false;
    this.statusTimer = setTimeout(() => this.pollStatus(), this.visible ? 1500 : 10000);
  }

  async browseFolder() {
    $('browse-folder').disabled = true; $('folder-message').textContent = 'Choose a folder in the Windows dialog…';
    try {
      const result = await api('folders/pick', {});
      if (result.path) $('folder-path').value = result.path;
      $('folder-message').textContent = '';
    } catch (error) { $('folder-message').textContent = `${error.message} You can also paste the folder path.`; }
    finally { $('browse-folder').disabled = false; }
  }

  async addFolder() {
    $('add-folder').disabled = true;
    try {
      await api('folders/add', { path: $('folder-path').value.trim() });
      $('folder-path').value = ''; $('folder-message').textContent = 'Folder added. Songs will appear as they are indexed.';
      this.pollStatus();
    } catch (error) { $('folder-message').textContent = error.message; }
    finally { $('add-folder').disabled = false; }
  }
}
