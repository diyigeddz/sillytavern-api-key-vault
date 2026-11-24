(() => {
    'use strict';

    const EXTENSION_ID = 'api-key-vault';
    const STORAGE_KEY = 'sillytavern-api-key-vault-v1';
    const BACKUP_TYPE = 'sillytavern-api-key-vault';
    const URL_SELECTORS = [
        '#custom_api_url_text',
        '#custom_api_url',
        'input[name="custom_api_url"]',
        'input[data-setting="custom_url"]',
    ];
    const KEY_SELECTORS = [
        '#api_key_custom',
        '#custom_api_key',
        'input[name="api_key_custom"]',
        'input[data-secret-key="api_key_custom"]',
    ];

    let state = loadState();
    let ui = {};
    let expandedChannelId = null;
    const expandedChannelManageIds = new Set();
    const expandedKeyActionIds = new Set();
    let editingChannelId = null;
    let editingKeyId = null;
    let editingKeyChannelId = null;
    let launcherObserver = null;
    let launcherTimer = null;
    let searchTimer = null;

    function makeId(prefix) {
        if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
        return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function loadState() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            const channels = Array.isArray(parsed.channels) ? parsed.channels : [];
            return { version: 2, channels: channels.map(normalizeChannel) };
        } catch (error) {
            console.warn(`[${EXTENSION_ID}] Could not read storage`, error);
            return { version: 2, channels: [] };
        }
    }

    function normalizeChannel(raw) {
        const now = new Date().toISOString();
        const keys = Array.isArray(raw?.keys) ? raw.keys.map(normalizeKey) : [];
        const legacyBalance = normalizeBalance(raw?.balance);
        if (keys.length && legacyBalance.status !== 'idle' && keys.every(key => key.balance.status === 'idle')) {
            keys[0].balance = legacyBalance;
        }
        return {
            id: typeof raw?.id === 'string' ? raw.id : makeId('channel'),
            name: String(raw?.name || '未命名渠道').slice(0, 100),
            url: String(raw?.url || '').trim(),
            source: String(raw?.source || '').slice(0, 80),
            tags: Array.isArray(raw?.tags) ? raw.tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 30) : [],
            notes: String(raw?.notes || '').slice(0, 3000),
            status: raw?.status === 'invalid' ? 'invalid' : 'active',
            keys,
            createdAt: raw?.createdAt || now,
            updatedAt: raw?.updatedAt || now,
        };
    }

    function normalizeKey(raw) {
        const now = new Date().toISOString();
        const day = Number(raw?.refreshDay);
        return {
            id: typeof raw?.id === 'string' ? raw.id : makeId('key'),
            name: String(raw?.name || '未命名 Key').slice(0, 100),
            value: String(raw?.value || ''),
            status: raw?.status === 'invalid' ? 'invalid' : 'active',
            refreshDay: Number.isInteger(day) && day >= 1 && day <= 31 ? day : null,
            expiresAt: /^\d{4}-\d{2}-\d{2}$/.test(String(raw?.expiresAt || '')) ? String(raw.expiresAt) : '',
            notes: String(raw?.notes || '').slice(0, 1000),
            balance: normalizeBalance(raw?.balance),
            createdAt: raw?.createdAt || now,
            updatedAt: raw?.updatedAt || now,
        };
    }

    function normalizeBalance(raw) {
        return {
            status: ['ok', 'loading', 'unsupported', 'error'].includes(raw?.status) ? raw.status : 'idle',
            text: String(raw?.text || ''),
            detail: String(raw?.detail || ''),
            checkedAt: raw?.checkedAt || '',
        };
    }

    function saveState() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
            return true;
        } catch (error) {
            console.error(`[${EXTENSION_ID}] Could not save storage`, error);
            toast('保存失败，浏览器本地空间可能已满', 'error');
            return false;
        }
    }

    function createElement(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }

    function makeButton(text, label, className, type = 'button') {
        const button = createElement('button', className, text);
        button.type = type;
        button.title = label;
        button.setAttribute('aria-label', label);
        return button;
    }

    function toast(message, kind = 'ok') {
        const node = createElement('div', `akv-toast akv-toast-${kind}`, message);
        document.body.appendChild(node);
        requestAnimationFrame(() => node.classList.add('is-visible'));
        setTimeout(() => {
            node.classList.remove('is-visible');
            setTimeout(() => node.remove(), 220);
        }, 2100);
    }

    function buildUi() {
        if (document.querySelector('#akv-overlay')) return;

        const overlay = createElement('dialog', 'akv-overlay');
        overlay.id = 'akv-overlay';
        overlay.setAttribute('aria-hidden', 'true');

        const sheet = createElement('section', 'akv-sheet');
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-label', 'API 密钥仓库');

        const handle = createElement('div', 'akv-drag-handle');
        const header = createElement('header', 'akv-header');
        const titleWrap = createElement('div', 'akv-title-wrap');
        const title = createElement('h2', 'akv-title', '密钥仓库');
        const count = createElement('span', 'akv-count', '0 个渠道');
        titleWrap.append(title, count);

        const headerActions = createElement('div', 'akv-header-actions');
        const addChannelButton = makeButton('＋', '新建渠道', 'akv-icon-button akv-primary-icon');
        const menuWrap = createElement('div', 'akv-menu-wrap');
        const menuButton = makeButton('⋯', '更多操作', 'akv-icon-button akv-more-button');
        const menu = createElement('div', 'akv-menu');
        menu.hidden = true;
        const refreshAllButton = makeButton('刷新全部额度', '刷新全部额度', 'akv-menu-item');
        const importButton = makeButton('导入备份', '导入备份', 'akv-menu-item');
        const exportButton = makeButton('导出明文备份', '导出明文备份', 'akv-menu-item');
        menu.append(refreshAllButton, importButton, exportButton);
        menuWrap.append(menuButton, menu);
        const closeButton = makeButton('×', '关闭', 'akv-icon-button');
        headerActions.append(addChannelButton, menuWrap, closeButton);
        header.append(titleWrap, headerActions);

        const toolbar = createElement('div', 'akv-toolbar');
        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'akv-search';
        search.placeholder = '搜索渠道、来源、模型或备注…';
        search.setAttribute('aria-label', '搜索密钥仓库');
        const filter = document.createElement('select');
        filter.className = 'akv-filter';
        filter.setAttribute('aria-label', '状态筛选');
        filter.append(new Option('全部', 'all'), new Option('正常', 'active'), new Option('失效', 'invalid'), new Option('有到期', 'expiring'));
        toolbar.append(search, filter);

        const main = createElement('main', 'akv-main');
        const list = createElement('div', 'akv-list');

        const channelEditor = createElement('form', 'akv-editor');
        channelEditor.hidden = true;
        const channelEditorTitle = createElement('div', 'akv-editor-title', '新建渠道');
        const channelName = makeInput('渠道名称，例如：Vaaya', 100);
        const channelUrl = makeInput('基础 URL，例如：https://example.com/v1', 1000);
        channelUrl.type = 'url';
        const channelSource = makeInput('来源分类，例如：小克、自建、打野', 80);
        const channelTags = makeInput('模型标签，用逗号分隔：Gemini, Claude', 500);
        const channelStatus = document.createElement('select');
        channelStatus.className = 'akv-input';
        channelStatus.append(new Option('正常', 'active'), new Option('暂时失效', 'invalid'));
        const channelNotes = document.createElement('textarea');
        channelNotes.className = 'akv-textarea akv-notes';
        channelNotes.placeholder = '备注：能吃什么模型、价格、速度、限制、是否容易截断……';
        const channelEditorActions = createElement('div', 'akv-editor-actions');
        const cancelChannel = makeButton('取消', '取消编辑渠道', 'akv-button akv-muted');
        const saveChannel = makeButton('保存渠道', '保存渠道', 'akv-button akv-accent', 'submit');
        channelEditorActions.append(cancelChannel, saveChannel);
        channelEditor.append(
            channelEditorTitle,
            makeField('渠道名称', channelName),
            makeField('基础 URL', channelUrl),
            makeField('来源分类', channelSource),
            makeField('模型标签', channelTags),
            makeField('渠道状态', channelStatus),
            makeField('备注', channelNotes),
            channelEditorActions,
        );

        const keyEditor = createElement('form', 'akv-editor');
        keyEditor.hidden = true;
        const keyEditorTitle = createElement('div', 'akv-editor-title', '添加 Key');
        const keyName = makeInput('Key 名称，例如：主账号、备用 1', 100);
        const keyValue = makeInput('直接粘贴完整 Key，不会隐藏', 10000);
        keyValue.autocomplete = 'off';
        keyValue.spellcheck = false;
        const keyStatus = document.createElement('select');
        keyStatus.className = 'akv-input';
        keyStatus.append(new Option('正常', 'active'), new Option('暂时失效', 'invalid'));
        const keyRefreshDay = makeInput('可选：每月几号刷新（1–31）', 2);
        keyRefreshDay.type = 'number';
        keyRefreshDay.min = '1';
        keyRefreshDay.max = '31';
        const keyExpiresAt = makeInput('', 10);
        keyExpiresAt.type = 'date';
        const keyNotes = document.createElement('textarea');
        keyNotes.className = 'akv-textarea akv-notes';
        keyNotes.placeholder = '可选备注';
        const keyEditorActions = createElement('div', 'akv-editor-actions');
        const cancelKey = makeButton('取消', '取消编辑 Key', 'akv-button akv-muted');
        const saveKey = makeButton('保存 Key', '保存 Key', 'akv-button akv-accent', 'submit');
        keyEditorActions.append(cancelKey, saveKey);
        keyEditor.append(
            keyEditorTitle,
            makeField('Key 名称', keyName),
            makeField('Key 明文', keyValue),
            makeField('Key 状态', keyStatus),
            makeField('月度刷新日', keyRefreshDay),
            makeField('到期日期', keyExpiresAt),
            makeField('备注', keyNotes),
            keyEditorActions,
        );

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.hidden = true;

        main.append(list, channelEditor, keyEditor);
        sheet.append(handle, header, toolbar, main, fileInput);
        overlay.appendChild(sheet);
        document.body.appendChild(overlay);

        ui = {
            overlay,
            sheet,
            count,
            addChannelButton,
            menu,
            toolbar,
            search,
            filter,
            list,
            channelEditor,
            channelEditorTitle,
            channelName,
            channelUrl,
            channelSource,
            channelTags,
            channelStatus,
            channelNotes,
            keyEditor,
            keyEditorTitle,
            keyName,
            keyValue,
            keyStatus,
            keyRefreshDay,
            keyExpiresAt,
            keyNotes,
            fileInput,
        };

        closeButton.addEventListener('click', closeVault);
        overlay.addEventListener('cancel', event => {
            event.preventDefault();
            handleBackOrClose();
        });
        overlay.addEventListener('click', event => {
            if (event.target === overlay) closeVault();
        });
        sheet.addEventListener('click', event => {
            event.stopPropagation();
            if (!event.target.closest('.akv-menu-wrap')) menu.hidden = true;
        });
        addChannelButton.addEventListener('click', () => openChannelEditor());
        menuButton.addEventListener('click', event => {
            event.stopPropagation();
            menu.hidden = !menu.hidden;
        });
        refreshAllButton.addEventListener('click', () => {
            menu.hidden = true;
            void refreshAllBalances();
        });
        importButton.addEventListener('click', () => {
            menu.hidden = true;
            fileInput.click();
        });
        exportButton.addEventListener('click', () => {
            menu.hidden = true;
            exportBackup();
        });
        fileInput.addEventListener('change', importBackup);
        cancelChannel.addEventListener('click', () => showView('list'));
        cancelKey.addEventListener('click', () => showView('list'));
        channelEditor.addEventListener('submit', saveChannelEditor);
        keyEditor.addEventListener('submit', saveKeyEditor);
        search.addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(renderList, 150);
        });
        filter.addEventListener('change', renderList);
        document.addEventListener('keydown', event => {
            if (event.key !== 'Escape' || !overlay.classList.contains('is-open')) return;
            handleBackOrClose();
        });
    }

    function makeInput(placeholder, maxLength) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'akv-input';
        input.placeholder = placeholder;
        input.maxLength = maxLength;
        return input;
    }

    function makeField(labelText, control) {
        const label = createElement('label', 'akv-field');
        const text = createElement('span', 'akv-field-label', labelText);
        label.append(text, control);
        return label;
    }

    function handleBackOrClose() {
        if (!ui.menu.hidden) {
            ui.menu.hidden = true;
            return;
        }
        if (!ui.channelEditor.hidden || !ui.keyEditor.hidden) {
            showView('list');
            return;
        }
        closeVault();
    }

    function setVaultOpen(open) {
        if (open) {
            if (!ui.overlay.open) {
                try {
                    ui.overlay.showModal();
                } catch (error) {
                    console.warn(`[${EXTENSION_ID}] showModal fallback`, error);
                    ui.overlay.setAttribute('open', '');
                }
            }
            ui.overlay.classList.add('is-open');
            ui.overlay.setAttribute('aria-hidden', 'false');
            ui.sheet.style.opacity = '1';
            ui.sheet.style.transform = 'translateY(0) scale(1)';
        } else {
            ui.overlay.classList.remove('is-open');
            ui.overlay.setAttribute('aria-hidden', 'true');
            ui.sheet.style.removeProperty('opacity');
            ui.sheet.style.removeProperty('transform');
            if (ui.overlay.open) ui.overlay.close();
        }
    }

    function openVault() {
        buildUi();
        state = loadState();
        showView('list');
        setVaultOpen(true);
    }

    function closeVault() {
        if (!ui.overlay) return;
        ui.menu.hidden = true;
        showView('list');
        setVaultOpen(false);
    }

    function showView(view) {
        if (!ui.list) return;
        ui.toolbar.hidden = view !== 'list';
        ui.list.hidden = view !== 'list';
        ui.channelEditor.hidden = view !== 'channel';
        ui.keyEditor.hidden = view !== 'key';
        ui.addChannelButton.hidden = view !== 'list';
        if (view === 'list') renderList();
    }

    function openChannelEditor(channel = null) {
        editingChannelId = channel?.id || null;
        ui.channelEditorTitle.textContent = channel ? '编辑渠道' : '新建渠道';
        ui.channelName.value = channel?.name || '';
        ui.channelUrl.value = channel?.url || readPageValue(URL_SELECTORS) || '';
        ui.channelSource.value = channel?.source || '';
        ui.channelTags.value = channel?.tags?.join(', ') || '';
        ui.channelStatus.value = channel?.status || 'active';
        ui.channelNotes.value = channel?.notes || '';
        showView('channel');
        ui.channelName.focus();
    }

    function saveChannelEditor(event) {
        event.preventDefault();
        const name = ui.channelName.value.trim();
        const url = ui.channelUrl.value.trim();
        if (!name || !url) {
            toast('渠道名称和 URL 不能空着', 'error');
            (!name ? ui.channelName : ui.channelUrl).focus();
            return;
        }

        const now = new Date().toISOString();
        const old = editingChannelId ? findChannel(editingChannelId) : null;
        const channel = normalizeChannel({
            ...old,
            id: old?.id || makeId('channel'),
            name,
            url,
            source: ui.channelSource.value.trim(),
            tags: parseTags(ui.channelTags.value),
            status: ui.channelStatus.value,
            notes: ui.channelNotes.value.trim(),
            keys: old?.keys || [],
            createdAt: old?.createdAt || now,
            updatedAt: now,
        });

        if (old) {
            const index = state.channels.findIndex(entry => entry.id === old.id);
            state.channels[index] = channel;
        } else {
            state.channels.push(channel);
        }
        saveState();
        expandedChannelId = channel.id;
        editingChannelId = null;
        showView('list');
        toast(old ? '渠道已更新' : '渠道已经放进仓库啦');
    }

    function openKeyEditor(channel, key = null) {
        editingKeyChannelId = channel.id;
        editingKeyId = key?.id || null;
        ui.keyEditorTitle.textContent = key ? `编辑 ${key.name}` : `给 ${channel.name} 添加 Key`;
        ui.keyName.value = key?.name || '';
        ui.keyValue.value = key?.value || readPageValue(KEY_SELECTORS) || '';
        ui.keyStatus.value = key?.status || 'active';
        ui.keyRefreshDay.value = key?.refreshDay || '';
        ui.keyExpiresAt.value = key?.expiresAt || '';
        ui.keyNotes.value = key?.notes || '';
        showView('key');
        (ui.keyValue.value ? ui.keyName : ui.keyValue).focus();
    }

    function saveKeyEditor(event) {
        event.preventDefault();
        const channel = findChannel(editingKeyChannelId);
        if (!channel) {
            toast('没有找到对应渠道', 'error');
            showView('list');
            return;
        }
        const value = ui.keyValue.value.trim();
        if (!value) {
            toast('Key 还是空的呀', 'error');
            ui.keyValue.focus();
            return;
        }

        const now = new Date().toISOString();
        const old = editingKeyId ? channel.keys.find(entry => entry.id === editingKeyId) : null;
        const key = normalizeKey({
            ...old,
            id: old?.id || makeId('key'),
            name: ui.keyName.value.trim() || `Key ${channel.keys.length + 1}`,
            value,
            status: ui.keyStatus.value,
            refreshDay: ui.keyRefreshDay.value ? Number(ui.keyRefreshDay.value) : null,
            expiresAt: ui.keyExpiresAt.value,
            notes: ui.keyNotes.value.trim(),
            createdAt: old?.createdAt || now,
            updatedAt: now,
        });

        if (old) {
            const index = channel.keys.findIndex(entry => entry.id === old.id);
            channel.keys[index] = key;
        } else {
            channel.keys.push(key);
        }
        channel.updatedAt = now;
        saveState();
        expandedChannelId = channel.id;
        editingKeyId = null;
        editingKeyChannelId = null;
        showView('list');
        toast(old ? 'Key 已更新' : 'Key 已添加');
    }

    function parseTags(value) {
        return [...new Set(String(value).split(/[,，、\n]/).map(tag => tag.trim()).filter(Boolean))].slice(0, 30);
    }

    function findChannel(id) {
        return state.channels.find(channel => channel.id === id) || null;
    }

    function renderList() {
        if (!ui.list) return;
        const query = ui.search.value.trim().toLocaleLowerCase('zh-CN');
        const filter = ui.filter.value;
        const channels = [...state.channels]
            .filter(channel => matchesChannelFilter(channel, filter))
            .filter(channel => !query || channelSearchText(channel).includes(query))
            .sort((left, right) => {
                if (left.status !== right.status) return left.status === 'active' ? -1 : 1;
                return String(right.updatedAt).localeCompare(String(left.updatedAt));
            });

        ui.count.textContent = `${state.channels.length} 个渠道`;
        ui.list.replaceChildren();
        if (!channels.length) {
            const empty = createElement('div', 'akv-empty');
            empty.append(
                createElement('div', 'akv-empty-icon', '🔐'),
                createElement('div', 'akv-empty-text', state.channels.length ? '没有找到匹配的渠道' : '仓库还是空的，先存一个渠道吧'),
            );
            ui.list.appendChild(empty);
            return;
        }
        for (const channel of channels) ui.list.appendChild(buildChannelCard(channel));
    }

    function matchesChannelFilter(channel, filter) {
        if (filter === 'active') return channel.status === 'active';
        if (filter === 'invalid') return channel.status === 'invalid';
        if (filter === 'expiring') return channel.keys.some(key => Boolean(key.expiresAt));
        return true;
    }

    function channelSearchText(channel) {
        return [
            channel.name,
            channel.url,
            channel.source,
            channel.tags.join(' '),
            channel.notes,
            ...channel.keys.flatMap(key => [key.name, key.notes]),
        ].join('\n').toLocaleLowerCase('zh-CN');
    }

    function buildChannelCard(channel) {
        const card = createElement('article', 'akv-channel');
        card.dataset.id = channel.id;
        if (channel.status === 'invalid') card.classList.add('is-invalid');
        const isExpanded = expandedChannelId === channel.id;
        if (isExpanded) card.classList.add('is-expanded');

        const summary = makeButton('', `展开 ${channel.name}`, 'akv-channel-summary');
        summary.setAttribute('aria-expanded', String(isExpanded));
        const summaryText = createElement('span', 'akv-channel-summary-text');
        const titleLine = createElement('span', 'akv-channel-title-line');
        const name = createElement('span', 'akv-channel-name', channel.name);
        titleLine.appendChild(name);
        if (channel.source) titleLine.appendChild(makeTag(channel.source, 'source'));
        for (const tag of channel.tags.slice(0, 4)) titleLine.appendChild(makeTag(tag, 'model'));
        if (channel.tags.length > 4) titleLine.appendChild(createElement('span', 'akv-more-tags', `+${channel.tags.length - 4}`));
        if (channel.status === 'invalid') titleLine.appendChild(createElement('span', 'akv-status-badge is-invalid', '渠道失效'));

        const url = createElement('span', 'akv-channel-url', channel.url);
        const meta = createElement('span', 'akv-channel-meta', keyCountSummary(channel));
        summaryText.append(titleLine, url, meta);
        const chevron = createElement('span', 'akv-chevron', '⌄');
        summary.append(summaryText, chevron);

        const body = createElement('div', 'akv-channel-body');
        body.hidden = !isExpanded;
        const manageOpen = expandedChannelManageIds.has(channel.id);
        const manageToggle = makeButton('', '展开渠道管理', 'akv-manage-toggle');
        manageToggle.setAttribute('aria-expanded', String(manageOpen));
        const manageLabel = createElement('span', '', '渠道管理');
        const manageHint = createElement('span', 'akv-manage-hint', channel.notes ? '备注 · 编辑 · 状态 · 删除' : '编辑 · 状态 · 删除');
        const manageChevron = createElement('span', 'akv-manage-chevron', '⌄');
        manageToggle.append(manageLabel, manageHint, manageChevron);
        const managePanel = createElement('div', 'akv-manage-panel');
        managePanel.hidden = !manageOpen;
        const notes = channel.notes ? createElement('div', 'akv-channel-notes', channel.notes) : null;
        const channelActions = createElement('div', 'akv-channel-actions');
        const editButton = makeButton('编辑渠道', '编辑渠道', 'akv-button akv-soft');
        const toggleButton = makeButton(channel.status === 'invalid' ? '恢复渠道' : '标记失效', channel.status === 'invalid' ? '恢复渠道' : '标记渠道失效', 'akv-button akv-soft');
        const deleteButton = makeButton('删除渠道', '删除整个渠道', 'akv-button akv-danger');
        channelActions.append(editButton, toggleButton, deleteButton);
        if (notes) managePanel.appendChild(notes);
        managePanel.appendChild(channelActions);

        const keysHeader = createElement('div', 'akv-keys-header');
        const keysTitle = createElement('strong', '', `Keys · ${channel.keys.length}`);
        const addKeyButton = makeButton('＋ 添加 Key', '添加 Key', 'akv-button akv-accent');
        keysHeader.append(keysTitle, addKeyButton);
        const keyList = createElement('div', 'akv-key-list');
        if (channel.keys.length) {
            for (const key of [...channel.keys].sort(sortKeys)) keyList.appendChild(buildKeyCard(channel, key));
        } else {
            keyList.appendChild(createElement('div', 'akv-no-keys', '这个渠道还没有 Key'));
        }

        body.append(manageToggle, managePanel, keysHeader, keyList);
        card.append(summary, body);

        summary.addEventListener('click', () => toggleChannel(card, channel.id));
        manageToggle.addEventListener('click', () => {
            const open = managePanel.hidden;
            managePanel.hidden = !open;
            manageToggle.setAttribute('aria-expanded', String(open));
            if (open) expandedChannelManageIds.add(channel.id);
            else expandedChannelManageIds.delete(channel.id);
        });
        editButton.addEventListener('click', () => openChannelEditor(channel));
        toggleButton.addEventListener('click', () => toggleChannelStatus(channel));
        deleteButton.addEventListener('click', () => deleteChannel(channel));
        addKeyButton.addEventListener('click', () => openKeyEditor(channel));
        return card;
    }

    function sortKeys(left, right) {
        const leftRank = getKeyDisplayStatus(left) === 'active' ? 0 : 1;
        const rightRank = getKeyDisplayStatus(right) === 'active' ? 0 : 1;
        if (leftRank !== rightRank) return leftRank - rightRank;
        return String(right.updatedAt).localeCompare(String(left.updatedAt));
    }

    function makeTag(text, kind) {
        const tag = createElement('span', `akv-tag akv-tag-${kind}`, text);
        tag.style.setProperty('--akv-tag-h', String(textHash(text) % 360));
        return tag;
    }

    function textHash(text) {
        let hash = 2166136261;
        for (const char of String(text)) {
            hash ^= char.codePointAt(0);
            hash = Math.imul(hash, 16777619);
        }
        return Math.abs(hash >>> 0);
    }

    function keyCountSummary(channel) {
        const checked = channel.keys.filter(key => key.balance.status !== 'idle').length;
        return `${channel.keys.length} 把 Key${checked ? ` · ${checked} 把有额度记录` : ''}`;
    }

    function buildBalanceLine(key) {
        const balance = key.balance;
        const line = createElement('div', `akv-balance akv-balance-${balance.status}`);
        const label = createElement('span', 'akv-balance-label', '额度');
        let text = '尚未读取';
        if (balance.status === 'loading') text = '正在尝试读取…';
        else if (balance.status === 'ok') text = balance.text || '已读取';
        else if (balance.status === 'unsupported') text = balance.text || '该渠道暂不支持读取';
        else if (balance.status === 'error') text = balance.text || '读取失败';
        const value = createElement('span', 'akv-balance-value', text);
        if (balance.detail) value.title = balance.detail;
        const time = balance.checkedAt ? createElement('span', 'akv-balance-time', `更新 ${formatShortDate(balance.checkedAt)}`) : null;
        line.append(label, value);
        if (time) line.appendChild(time);
        return line;
    }

    function buildKeyCard(channel, key) {
        const status = getKeyDisplayStatus(key);
        const card = createElement('div', `akv-key-card is-${status}`);
        const top = createElement('div', 'akv-key-top');
        const name = createElement('strong', 'akv-key-name', key.name);
        const badges = createElement('span', 'akv-key-badges');
        badges.appendChild(createElement('span', `akv-status-badge is-${status}`, statusLabel(status)));
        if (key.refreshDay) badges.appendChild(createElement('span', 'akv-mini-badge', nextRefreshLabel(key.refreshDay)));
        if (key.expiresAt) badges.appendChild(createElement('span', 'akv-mini-badge', expiryLabel(key.expiresAt)));
        const actionOpen = expandedKeyActionIds.has(key.id);
        const actionToggle = makeButton('', `展开 ${key.name} 的操作`, 'akv-key-toggle');
        actionToggle.setAttribute('aria-expanded', String(actionOpen));
        actionToggle.append(createElement('span', '', '操作'), createElement('span', 'akv-key-toggle-chevron', '⌄'));
        const topRight = createElement('span', 'akv-key-top-right');
        topRight.append(badges, actionToggle);
        top.append(name, topRight);

        const value = document.createElement('input');
        value.type = 'text';
        value.className = 'akv-key-value';
        value.value = key.value;
        value.readOnly = true;
        value.spellcheck = false;
        value.setAttribute('aria-label', `${key.name} 明文`);

        const details = createElement('div', 'akv-key-details');
        details.hidden = !actionOpen;
        const balance = buildBalanceLine(key);
        const notes = key.notes ? createElement('div', 'akv-key-notes', key.notes) : null;
        const actions = createElement('div', 'akv-key-actions');
        const readBalanceButton = makeButton('读取额度', '读取这把 Key 的额度', 'akv-key-action akv-key-balance');
        const fill = makeButton('填入', '填入酒馆 URL 与密钥框', 'akv-key-action akv-fill');
        const copy = makeButton('复制', '复制到系统剪贴板', 'akv-key-action');
        const edit = makeButton('编辑', '编辑 Key', 'akv-key-action');
        const toggle = makeButton(key.status === 'invalid' ? '恢复' : '失效', key.status === 'invalid' ? '恢复 Key' : '标记 Key 失效', 'akv-key-action');
        const remove = makeButton('删除', '删除 Key', 'akv-key-action akv-key-delete');
        actions.append(readBalanceButton, fill, copy, edit, toggle, remove);

        card.append(top, value);
        details.appendChild(balance);
        if (notes) details.appendChild(notes);
        details.appendChild(actions);
        card.appendChild(details);

        value.addEventListener('click', () => value.select());
        actionToggle.addEventListener('click', () => {
            const open = details.hidden;
            details.hidden = !open;
            actionToggle.setAttribute('aria-expanded', String(open));
            if (open) expandedKeyActionIds.add(key.id);
            else expandedKeyActionIds.delete(key.id);
        });
        readBalanceButton.addEventListener('click', () => void readBalance(channel.id, key.id));
        fill.addEventListener('click', () => fillIntoSillyTavern(channel, key));
        copy.addEventListener('click', () => void copyText(key.value));
        edit.addEventListener('click', () => openKeyEditor(channel, key));
        toggle.addEventListener('click', () => toggleKeyStatus(channel, key));
        remove.addEventListener('click', () => deleteKey(channel, key));
        return card;
    }

    function getKeyDisplayStatus(key) {
        if (key.status === 'invalid') return 'invalid';
        if (key.expiresAt && endOfLocalDay(key.expiresAt).getTime() < Date.now()) return 'expired';
        return 'active';
    }

    function statusLabel(status) {
        if (status === 'invalid') return '失效';
        if (status === 'expired') return '已过期';
        return '正常';
    }

    function endOfLocalDay(dateString) {
        const [year, month, day] = dateString.split('-').map(Number);
        return new Date(year, month - 1, day, 23, 59, 59, 999);
    }

    function expiryLabel(dateString) {
        const end = endOfLocalDay(dateString);
        const days = Math.ceil((end.getTime() - Date.now()) / 86400000);
        if (days < 0) return `${dateString} 已过期`;
        if (days === 0) return '今天到期';
        return `${dateString} 到期 · ${days} 天`;
    }

    function nextRefreshLabel(day) {
        const now = new Date();
        let target = new Date(now.getFullYear(), now.getMonth(), Math.min(day, daysInMonth(now.getFullYear(), now.getMonth())), 0, 0, 0, 0);
        if (target.getTime() < now.getTime()) {
            const nextMonth = now.getMonth() + 1;
            const year = now.getFullYear() + Math.floor(nextMonth / 12);
            const month = nextMonth % 12;
            target = new Date(year, month, Math.min(day, daysInMonth(year, month)), 0, 0, 0, 0);
        }
        return `下次 ${String(target.getMonth() + 1).padStart(2, '0')}/${String(target.getDate()).padStart(2, '0')} 刷新`;
    }

    function daysInMonth(year, zeroBasedMonth) {
        return new Date(year, zeroBasedMonth + 1, 0).getDate();
    }

    function setChannelExpanded(card, expanded) {
        card.classList.toggle('is-expanded', expanded);
        card.querySelector('.akv-channel-summary')?.setAttribute('aria-expanded', String(expanded));
        const body = card.querySelector('.akv-channel-body');
        if (body) body.hidden = !expanded;
    }

    function toggleChannel(card, id) {
        const expand = !card.classList.contains('is-expanded');
        const previous = ui.list.querySelector('.akv-channel.is-expanded');
        if (previous && previous !== card) setChannelExpanded(previous, false);
        setChannelExpanded(card, expand);
        expandedChannelId = expand ? id : null;
        if (expand) requestAnimationFrame(() => card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }

    function toggleChannelStatus(channel) {
        channel.status = channel.status === 'invalid' ? 'active' : 'invalid';
        channel.updatedAt = new Date().toISOString();
        saveState();
        renderList();
        toast(channel.status === 'invalid' ? '渠道已标记失效' : '渠道已恢复');
    }

    function deleteChannel(channel) {
        const count = channel.keys.length;
        const message = `确定删除“${channel.name}”吗？\n该渠道的 URL、备注和 ${count} 把 Key 会一并删除。`;
        if (!window.confirm(message)) return;
        state.channels = state.channels.filter(entry => entry.id !== channel.id);
        if (expandedChannelId === channel.id) expandedChannelId = null;
        saveState();
        renderList();
        toast('整个渠道已删除');
    }

    function toggleKeyStatus(channel, key) {
        key.status = key.status === 'invalid' ? 'active' : 'invalid';
        key.updatedAt = new Date().toISOString();
        channel.updatedAt = key.updatedAt;
        saveState();
        renderList();
        toast(key.status === 'invalid' ? 'Key 已标记失效' : 'Key 已恢复');
    }

    function deleteKey(channel, key) {
        if (!window.confirm(`确定删除“${key.name}”吗？`)) return;
        channel.keys = channel.keys.filter(entry => entry.id !== key.id);
        channel.updatedAt = new Date().toISOString();
        saveState();
        renderList();
        toast('Key 已删除');
    }

    function fillIntoSillyTavern(channel, key) {
        const urlInput = findPageInput(URL_SELECTORS, /自定义端点|Custom Endpoint|Base URL/i);
        const keyInput = findPageInput(KEY_SELECTORS, /自定义 API 密钥|Custom API Key/i);
        if (!urlInput || !keyInput) {
            toast('没有找到酒馆的 URL 或密钥输入框', 'error');
            return;
        }
        setInputValue(urlInput, channel.url);
        setInputValue(keyInput, key.value);
        closeVault();
        keyInput.focus();
        toast(`已填入 ${channel.name} · ${key.name}`);
    }

    function setInputValue(input, value) {
        const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function copyText(text) {
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
            await navigator.clipboard.writeText(text);
            toast('已复制到系统剪贴板');
            return;
        } catch {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            const copied = document.execCommand('copy');
            textarea.remove();
            toast(copied ? '已复制到系统剪贴板' : '复制失败，请长按明文复制', copied ? 'ok' : 'error');
        }
    }

    function findPageInput(selectors, labelPattern) {
        for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element;
        }
        const candidates = [...document.querySelectorAll('label, h4, h5, .title_restorable, .settings-section-title, div, span')]
            .filter(element => labelPattern.test((element.textContent || '').trim()) && (element.textContent || '').trim().length < 80);
        for (const label of candidates) {
            const labelledId = label.getAttribute('for');
            const labelled = labelledId ? document.getElementById(labelledId) : null;
            if (labelled instanceof HTMLInputElement || labelled instanceof HTMLTextAreaElement) return labelled;
            const container = label.closest('.flex-container, .range-block, .settings-section, .inline-drawer-content, div');
            const input = container?.querySelector('input:not([type="hidden"]), textarea');
            if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) return input;
        }
        return null;
    }

    function readPageValue(selectors) {
        return findPageInput(selectors, /$a/)?.value || '';
    }

    function ensureLauncher() {
        const existing = document.querySelector('#akv-launcher');
        const keyInput = findPageInput(KEY_SELECTORS, /自定义 API 密钥|Custom API Key/i);
        if (!keyInput) return false;

        const row = keyInput.closest('.flex-container') || keyInput.parentElement;
        if (!row) return false;
        if (existing) {
            if (existing.parentElement !== row) row.appendChild(existing);
            return true;
        }

        const launcher = makeButton('🔐', '打开 API 密钥仓库', 'akv-launcher');
        launcher.id = 'akv-launcher';
        launcher.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            openVault();
        });
        row.appendChild(launcher);
        return true;
    }

    async function readBalance(channelId, keyId) {
        const channel = findChannel(channelId);
        if (!channel) return;
        const key = channel.keys.find(entry => entry.id === keyId);
        if (!key?.value) {
            toast('没有找到这把 Key', 'error');
            return;
        }

        key.balance = { status: 'loading', text: '正在尝试读取…', detail: '', checkedAt: '' };
        saveState();
        expandedKeyActionIds.add(key.id);
        renderList();

        const candidates = buildBalanceCandidates(channel.url);
        let sawAuthError = false;
        let sawNetworkError = false;
        let lastDetail = '';
        for (const candidate of candidates) {
            try {
                const response = await fetchWithTimeout(candidate, key.value, 6500);
                if (response.status === 401 || response.status === 403) {
                    sawAuthError = true;
                    lastDetail = `${response.status} ${response.statusText}`;
                    continue;
                }
                if (!response.ok) {
                    lastDetail = `${response.status} ${response.statusText}`;
                    continue;
                }
                const data = await response.json();
                const parsed = parseBalance(data, candidate);
                if (parsed) {
                    setBalance(channel, key, 'ok', parsed, candidate);
                    return;
                }
                lastDetail = '接口返回成功，但没有识别到余额字段';
            } catch (error) {
                sawNetworkError = true;
                lastDetail = String(error?.message || error);
            }
        }

        if (sawAuthError) setBalance(channel, key, 'error', '认证失败（401/403）', lastDetail);
        else if (sawNetworkError) setBalance(channel, key, 'unsupported', '浏览器未能读取余额', '可能是渠道未提供余额接口，或没有允许浏览器跨域访问');
        else setBalance(channel, key, 'unsupported', '未找到可读取的余额接口', lastDetail);
    }

    function setBalance(channel, key, status, text, detail) {
        key.balance = {
            status,
            text,
            detail,
            checkedAt: new Date().toISOString(),
        };
        saveState();
        expandedChannelId = channel.id;
        expandedKeyActionIds.add(key.id);
        renderList();
        if (status === 'ok') toast(`${key.name}：${text}`);
        else toast(`${key.name}：${text}`, status === 'error' ? 'error' : 'info');
    }

    async function refreshAllBalances() {
        const targets = state.channels.flatMap(channel => channel.status === 'active'
            ? channel.keys.filter(key => getKeyDisplayStatus(key) === 'active').map(key => ({ channel, key }))
            : []);
        if (!targets.length) {
            toast('没有可刷新的 Key', 'info');
            return;
        }
        toast(`开始尝试读取 ${targets.length} 把 Key`);
        for (const { channel, key } of targets) await readBalance(channel.id, key.id);
        toast('额度读取完成');
    }

    function buildBalanceCandidates(url) {
        const clean = String(url).trim().replace(/\/+$/, '');
        const root = clean.replace(/\/v1$/i, '');
        const host = safeHost(clean);
        const candidates = [];
        if (host.includes('openrouter.ai')) candidates.push('https://openrouter.ai/api/v1/auth/key');
        candidates.push(
            `${root}/dashboard/billing/credit_grants`,
            `${clean}/balance`,
            `${clean}/credits`,
            `${root}/api/v1/balance`,
        );
        return [...new Set(candidates)].slice(0, 5);
    }

    function safeHost(url) {
        try {
            return new URL(url).hostname.toLowerCase();
        } catch {
            return '';
        }
    }

    async function fetchWithTimeout(url, key, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${key}`,
                    Accept: 'application/json',
                },
                credentials: 'omit',
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
    }

    function parseBalance(data, endpoint) {
        const source = data?.data && typeof data.data === 'object' ? data.data : data;
        if (!source || typeof source !== 'object') return null;

        const limitRemaining = findNumber(source, ['limit_remaining', 'remaining', 'credit_balance', 'balance', 'credits', 'available', 'total_available']);
        if (limitRemaining !== null) return formatBalanceValue(limitRemaining, endpoint);

        const granted = findNumber(source, ['total_granted', 'granted', 'limit']);
        const used = findNumber(source, ['total_used', 'used', 'usage']);
        if (granted !== null && used !== null) return `剩余 ${formatNumber(granted - used)} · 已用 ${formatNumber(used)}`;
        if (used !== null) return `已使用 ${formatNumber(used)}`;
        return null;
    }

    function findNumber(object, names, depth = 0) {
        if (!object || typeof object !== 'object' || depth > 3) return null;
        const wanted = new Set(names.map(name => name.toLowerCase()));
        for (const [key, value] of Object.entries(object)) {
            if (wanted.has(key.toLowerCase())) {
                const number = Number(value);
                if (Number.isFinite(number)) return number;
            }
        }
        for (const value of Object.values(object)) {
            if (value && typeof value === 'object') {
                const found = findNumber(value, names, depth + 1);
                if (found !== null) return found;
            }
        }
        return null;
    }

    function formatBalanceValue(value, endpoint) {
        if (/openrouter|billing|credit/i.test(endpoint)) return `剩余 $${formatNumber(value)}`;
        return `剩余 ${formatNumber(value)}`;
    }

    function formatNumber(value) {
        return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value);
    }

    function formatShortDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(date);
    }

    function exportBackup() {
        if (!window.confirm('导出的 JSON 会包含全部明文 Key。请妥善保管，仍要继续吗？')) return;
        const payload = {
            type: BACKUP_TYPE,
            version: 2,
            exportedAt: new Date().toISOString(),
            channels: state.channels,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `API密钥仓库_明文备份_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        toast(`已导出 ${state.channels.length} 个渠道`);
    }

    async function importBackup(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const parsed = JSON.parse(await file.text());
            const channels = Array.isArray(parsed) ? parsed : parsed.channels;
            if (!Array.isArray(channels)) throw new Error('Invalid backup');
            const incoming = channels.map(normalizeChannel).filter(channel => channel.url);
            if (!window.confirm(`将导入 ${incoming.length} 个渠道。同 ID 的渠道会被覆盖，继续吗？`)) return;
            const byId = new Map(state.channels.map(channel => [channel.id, channel]));
            for (const channel of incoming) byId.set(channel.id, channel);
            state.channels = [...byId.values()];
            saveState();
            renderList();
            toast(`成功导入 ${incoming.length} 个渠道`);
        } catch (error) {
            console.error(`[${EXTENSION_ID}] Import failed`, error);
            toast('这个备份文件读不出来', 'error');
        }
    }

    function initialize() {
        buildUi();
        ensureLauncher();
        launcherObserver = new MutationObserver(() => {
            clearTimeout(launcherTimer);
            launcherTimer = setTimeout(ensureLauncher, 120);
        });
        launcherObserver.observe(document.body, { childList: true, subtree: true });
        console.info(`[${EXTENSION_ID}] ready v0.2.1`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
