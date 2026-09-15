(function() {
  if (window.__dsh_tauri_injected__) return;
  window.__dsh_tauri_injected__ = true;

  // Helper to invoke Tauri IPC
  const invoke = (cmd, args = {}) => {
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke(cmd, args);
    }
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
      return window.__TAURI__.core.invoke(cmd, args);
    }
    return Promise.reject(new Error('Tauri IPC is not available'));
  };

  // 1. Native API Objects
  window.dshDesktop = Object.freeze({
    restartHarness: () => invoke('restart_harness').then(() => ({ ok: true })).catch(err => ({ ok: false, error: String(err) })),
    uninstallMarket: () => invoke('uninstall_market').then(() => ({ ok: true })).catch(err => ({ ok: false, error: String(err) })),
    openInFinder: (path) => invoke('open_in_finder', { path }).then(() => ({ ok: true })).catch(err => ({ ok: false, error: String(err) }))
  });

  window.dshDesktopDirectoryPicker = Object.freeze({
    pick: () => invoke('pick_directory').catch(err => {
      console.error('[tauri-bridge] pick_directory failed:', err);
      return null;
    })
  });

  window.dshRecovery = Object.freeze({
    action: (action) => invoke('recovery_action', { action }).then(() => ({ ok: true })).catch(err => ({ ok: false, error: String(err) }))
  });

  window.dshWebImport = Object.freeze({
    action: (action) => invoke('web_import_action', { action }).then(() => ({ ok: true })).catch(err => ({ ok: false, error: String(err) }))
  });

  window.dshSafeMode = Object.freeze({
    action: (action, selection = {}) => invoke('safe_mode_action', { action, selection }).then(() => ({ ok: true })).catch(err => ({ ok: false, error: String(err) }))
  });

  // 2. Mobile Connection Button & Sidebar Integration
  const MOBILE_BUTTON_ID = 'dsh-desktop-mobile-button';
  const phoneIcon = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true"><rect x="7" y="2.75" width="10" height="18.5" rx="2.25" stroke="currentColor" stroke-width="1.7"/><path d="M10.2 5.5h3.6M10.5 18.35h3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg><span aria-hidden="true"></span>`;

  const mobileButtonStyles = `
    [data-dsh-sidebar-settings] { position:relative; box-sizing:border-box; }
    [data-dsh-sidebar-root][data-dsh-sidebar-wide="true"] [data-dsh-sidebar-settings] { padding-right:38px; }
    #${MOBILE_BUTTON_ID} { appearance:none; position:relative; width:32px; height:32px; color:var(--dsw-alias-label-secondary,#73777f); background:transparent; border:0; border-radius:9px; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; }
    [data-dsh-sidebar-root][data-dsh-sidebar-wide="true"] #${MOBILE_BUTTON_ID} { position:absolute; right:0; top:50%; transform:translateY(-50%); }
    [data-dsh-sidebar-root][data-dsh-sidebar-wide="false"] [data-dsh-sidebar-settings] { flex-direction:column; align-items:center; }
    [data-dsh-sidebar-root][data-dsh-sidebar-wide="false"] #${MOBILE_BUTTON_ID} { flex:none; margin-top:5px; }
    #${MOBILE_BUTTON_ID}:hover { color:var(--dsw-alias-label-primary,#202124); background:var(--dsw-alias-interactive-bg-hover,rgba(32,33,36,.08)); }
    #${MOBILE_BUTTON_ID}:focus-visible { outline:2px solid #4d6bfe; outline-offset:1px; }
    #${MOBILE_BUTTON_ID}[hidden] { display:none; }
    #${MOBILE_BUTTON_ID} > span { position:absolute; top:4px; right:4px; width:7px; height:7px; border:1.5px solid var(--dsw-specific-sidebar-fill,#fff); border-radius:50%; background:#4da66d; opacity:0; }
    #${MOBILE_BUTTON_ID}.is-connected > span { opacity:1; }
  `;

  let mobileConnected = false;
  const isZh = navigator.language.toLowerCase().startsWith('zh');

  function updateMobileButtonState(btn) {
    if (!btn) return;
    btn.classList.toggle('is-connected', mobileConnected);
    const label = mobileConnected ? (isZh ? '管理手机连接' : 'Manage phone connection') : (isZh ? '连接手机' : 'Connect phone');
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  function mountMobileButton() {
    if (!document.getElementById(`${MOBILE_BUTTON_ID}-style`)) {
      const style = document.createElement('style');
      style.id = `${MOBILE_BUTTON_ID}-style`;
      style.textContent = mobileButtonStyles;
      document.head.appendChild(style);
    }

    const settingsArea = document.querySelector('[data-dsh-sidebar-settings]');
    if (!settingsArea) return;

    let button = document.getElementById(MOBILE_BUTTON_ID);
    if (!button) {
      button = document.createElement('button');
      button.id = MOBILE_BUTTON_ID;
      button.type = 'button';
      button.innerHTML = phoneIcon;
      button.addEventListener('click', () => {
        invoke('mobile_open_pairing').catch(err => {
          console.error('[mobile] failed to open pairing window:', err);
        });
      });
      settingsArea.appendChild(button);
    } else if (button.parentElement !== settingsArea) {
      settingsArea.appendChild(button);
    }

    updateMobileButtonState(button);
  }

  // Check mobile connection status
  function syncMobileStatus() {
    invoke('mobile_status')
      .then(res => {
        if (res && typeof res.connected === 'boolean') {
          mobileConnected = res.connected;
          updateMobileButtonState(document.getElementById(MOBILE_BUTTON_ID));
        }
      })
      .catch(() => {});
  }

  // Observer to inject button as soon as sidebar renders
  const observer = new MutationObserver(() => {
    mountMobileButton();
  });

  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
    mountMobileButton();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, { childList: true, subtree: true });
      mountMobileButton();
    });
  }

  setInterval(syncMobileStatus, 3000);
  syncMobileStatus();

  console.log('[tauri-bridge] DeepSeek Harness Desktop Tauri bridge & mobile connector initialized');
})();
